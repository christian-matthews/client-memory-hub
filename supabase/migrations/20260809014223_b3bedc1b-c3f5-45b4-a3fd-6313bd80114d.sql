-- ============================================================
-- 1) IDEMPOTENCY (real, atomic — not the audit table)
-- ============================================================
CREATE TYPE public.idempotency_status AS ENUM ('in_progress', 'completed', 'failed');

CREATE TABLE public.idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  operation text NOT NULL,
  actor_type public.actor_type NOT NULL DEFAULT 'user',
  request_hash text NOT NULL,
  status public.idempotency_status NOT NULL DEFAULT 'in_progress',
  result jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (workspace_id, key)
);

GRANT SELECT ON public.idempotency_keys TO authenticated;
GRANT ALL ON public.idempotency_keys TO service_role;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read idempotency keys" ON public.idempotency_keys
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));

-- Authorization helper shared by the transactional RPCs: a signed-in caller
-- must be a member of the workspace; service_role callers are trusted because
-- the workspace is resolved server-side from an integration credential.
CREATE OR REPLACE FUNCTION public.assert_workspace_access(_workspace_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF _workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_required';
  END IF;
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.workspace_members m
                   WHERE m.workspace_id = _workspace_id AND m.user_id = auth.uid()) THEN
      RAISE EXCEPTION 'forbidden_workspace';
    END IF;
  ELSIF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_workspace';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.assert_workspace_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_workspace_access(uuid) TO authenticated, service_role;

-- ============================================================
-- 2) ATOMIC COMPOSITE OPERATION: add_topic_update
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_topic_update_tx(
  p_workspace_id uuid,
  p_topic_id uuid,
  p_content text,
  p_update_type public.update_type DEFAULT 'note',
  p_is_relevant boolean DEFAULT true,
  p_status public.topic_status DEFAULT NULL,
  p_ball_with public.party DEFAULT NULL,
  p_current_state text DEFAULT NULL,
  p_next_step_set boolean DEFAULT false,
  p_next_step text DEFAULT NULL,
  p_next_step_owner public.party DEFAULT 'nobody',
  p_next_step_due_at timestamptz DEFAULT NULL,
  p_decision text DEFAULT NULL,
  p_commitment jsonb DEFAULT NULL,
  p_source_id uuid DEFAULT NULL,
  p_actor_type public.actor_type DEFAULT 'user',
  p_actor_user_id uuid DEFAULT NULL,
  p_actor_name text DEFAULT NULL,
  p_actor_channel text DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_topic public.topics;
  v_update_id uuid;
  v_effects text[] := '{}';
  v_now timestamptz := now();
  v_existing public.idempotency_keys;
  v_result jsonb;
  v_decision_id uuid;
  v_commitment_id uuid;
BEGIN
  PERFORM public.assert_workspace_access(p_workspace_id);

  IF p_content IS NULL OR length(btrim(p_content)) = 0 THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  -- Atomic idempotency reservation inside the same transaction as the writes.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.idempotency_keys (workspace_id, key, operation, actor_type, request_hash)
    VALUES (p_workspace_id, p_idempotency_key, 'add_topic_update', p_actor_type, coalesce(p_request_hash, ''))
    ON CONFLICT (workspace_id, key) DO NOTHING;

    IF NOT FOUND THEN
      -- Blocks until a concurrent holder commits or rolls back.
      SELECT * INTO v_existing FROM public.idempotency_keys
      WHERE workspace_id = p_workspace_id AND key = p_idempotency_key FOR UPDATE;

      IF v_existing.request_hash <> coalesce(p_request_hash, '') THEN
        RAISE EXCEPTION 'idempotency_conflict';
      END IF;
      IF v_existing.status = 'completed' THEN
        RETURN v_existing.result;
      END IF;
      -- 'failed' or an abandoned reservation: retry under the same key.
      UPDATE public.idempotency_keys
      SET status = 'in_progress', error_message = NULL, created_at = v_now
      WHERE workspace_id = p_workspace_id AND key = p_idempotency_key;
    END IF;
  END IF;

  SELECT * INTO v_topic FROM public.topics
  WHERE workspace_id = p_workspace_id AND id = p_topic_id;
  IF v_topic.id IS NULL THEN
    RAISE EXCEPTION 'topic_not_found';
  END IF;

  INSERT INTO public.topic_updates
    (workspace_id, client_id, topic_id, update_type, content, is_relevant, created_by)
  VALUES
    (p_workspace_id, v_topic.client_id, v_topic.id, p_update_type, p_content, p_is_relevant, p_actor_user_id)
  RETURNING id INTO v_update_id;
  v_effects := v_effects || 'actualización registrada';

  UPDATE public.topics SET
    status = COALESCE(p_status, status),
    resolved_at = CASE WHEN p_status = 'resolved' THEN v_now ELSE resolved_at END,
    archived_at = CASE WHEN p_status = 'archived' THEN v_now ELSE archived_at END,
    ball_with = COALESCE(p_ball_with, ball_with),
    current_state = COALESCE(p_current_state, current_state),
    next_step = CASE WHEN p_next_step_set THEN p_next_step ELSE next_step END,
    next_step_owner = CASE WHEN p_next_step_set THEN COALESCE(p_next_step_owner,'nobody') ELSE next_step_owner END,
    next_step_due_at = CASE WHEN p_next_step_set THEN p_next_step_due_at ELSE next_step_due_at END,
    last_relevant_change_at = CASE WHEN p_is_relevant THEN v_now ELSE last_relevant_change_at END
  WHERE workspace_id = p_workspace_id AND id = p_topic_id;

  IF p_status IS NOT NULL AND p_status <> v_topic.status THEN
    v_effects := v_effects || ('estado → ' || p_status::text);
  END IF;
  IF p_ball_with IS NOT NULL AND p_ball_with <> v_topic.ball_with THEN
    v_effects := v_effects || ('pelota → ' || p_ball_with::text);
  END IF;
  IF p_current_state IS NOT NULL THEN
    v_effects := v_effects || 'estado actual actualizado';
  END IF;
  IF p_next_step_set THEN
    v_effects := v_effects || 'próximo paso actualizado';
  END IF;

  IF p_decision IS NOT NULL AND length(btrim(p_decision)) > 0 THEN
    INSERT INTO public.decisions
      (workspace_id, client_id, topic_id, description, source_id, created_by)
    VALUES
      (p_workspace_id, v_topic.client_id, v_topic.id, p_decision, p_source_id, p_actor_user_id)
    RETURNING id INTO v_decision_id;
    v_effects := v_effects || 'decisión registrada';
  END IF;

  IF p_commitment IS NOT NULL AND p_commitment ? 'description' THEN
    INSERT INTO public.commitments
      (workspace_id, client_id, topic_id, description, responsible_party, responsible_name, due_at)
    VALUES (
      p_workspace_id, v_topic.client_id, v_topic.id,
      p_commitment->>'description',
      (p_commitment->>'responsibleParty')::public.responsible_party,
      NULLIF(p_commitment->>'responsibleName',''),
      NULLIF(p_commitment->>'dueAt','')::timestamptz
    ) RETURNING id INTO v_commitment_id;
    v_effects := v_effects || 'compromiso creado';
  END IF;

  IF p_source_id IS NOT NULL THEN
    INSERT INTO public.topic_sources (workspace_id, topic_id, source_id, linked_by)
    VALUES (p_workspace_id, v_topic.id, p_source_id, p_actor_user_id)
    ON CONFLICT (topic_id, source_id) DO NOTHING;
    v_effects := v_effects || 'fuente vinculada';
  END IF;

  IF p_is_relevant THEN
    UPDATE public.clients SET last_relevant_activity_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_topic.client_id;
  END IF;

  INSERT INTO public.activity_events (
    workspace_id, client_id, topic_id, actor_type, actor_user_id, actor_name,
    event_type, entity_type, entity_id, description, input_summary, metadata,
    correlation_id, idempotency_key
  ) VALUES (
    p_workspace_id, v_topic.client_id, v_topic.id, p_actor_type, p_actor_user_id, p_actor_name,
    'topic.update_added', 'topic_update', v_update_id,
    'Actualización en “' || v_topic.title || '”: ' || array_to_string(v_effects, ', '),
    left(p_content, 200),
    jsonb_build_object('effects', to_jsonb(v_effects), 'channel', p_actor_channel),
    COALESCE(p_correlation_id, gen_random_uuid()), p_idempotency_key
  );

  v_result := jsonb_build_object(
    'updateId', v_update_id,
    'topicId', v_topic.id,
    'clientId', v_topic.client_id,
    'decisionId', v_decision_id,
    'commitmentId', v_commitment_id,
    'effects', to_jsonb(v_effects),
    'replayed', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.idempotency_keys
    SET status = 'completed', result = jsonb_set(v_result, '{replayed}', 'true'::jsonb), completed_at = v_now
    WHERE workspace_id = p_workspace_id AND key = p_idempotency_key;
  END IF;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.add_topic_update_tx(uuid,uuid,text,public.update_type,boolean,public.topic_status,public.party,text,boolean,text,public.party,timestamptz,text,jsonb,uuid,public.actor_type,uuid,text,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_topic_update_tx(uuid,uuid,text,public.update_type,boolean,public.topic_status,public.party,text,boolean,text,public.party,timestamptz,text,jsonb,uuid,public.actor_type,uuid,text,text,uuid,text,text) TO authenticated, service_role;

-- ============================================================
-- 3) Generic atomic idempotency reserve/finish for the other write actions
-- ============================================================
CREATE OR REPLACE FUNCTION public.idempotency_reserve(
  p_workspace_id uuid, p_key text, p_operation text, p_request_hash text,
  p_actor_type public.actor_type DEFAULT 'user'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_existing public.idempotency_keys;
BEGIN
  PERFORM public.assert_workspace_access(p_workspace_id);
  IF p_key IS NULL THEN RETURN jsonb_build_object('state','skipped'); END IF;

  INSERT INTO public.idempotency_keys (workspace_id, key, operation, actor_type, request_hash)
  VALUES (p_workspace_id, p_key, p_operation, p_actor_type, coalesce(p_request_hash,''))
  ON CONFLICT (workspace_id, key) DO NOTHING;
  IF FOUND THEN RETURN jsonb_build_object('state','reserved'); END IF;

  SELECT * INTO v_existing FROM public.idempotency_keys
  WHERE workspace_id = p_workspace_id AND key = p_key FOR UPDATE;

  IF v_existing.request_hash <> coalesce(p_request_hash,'') THEN
    RETURN jsonb_build_object('state','conflict');
  END IF;
  IF v_existing.status = 'completed' THEN
    RETURN jsonb_build_object('state','completed','result',v_existing.result);
  END IF;
  IF v_existing.status = 'in_progress' AND v_existing.created_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('state','in_progress');
  END IF;
  UPDATE public.idempotency_keys SET status='in_progress', error_message=NULL, created_at=now()
  WHERE workspace_id = p_workspace_id AND key = p_key;
  RETURN jsonb_build_object('state','reserved');
END $$;

CREATE OR REPLACE FUNCTION public.idempotency_finish(
  p_workspace_id uuid, p_key text, p_ok boolean, p_result jsonb DEFAULT NULL, p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  PERFORM public.assert_workspace_access(p_workspace_id);
  IF p_key IS NULL THEN RETURN; END IF;
  UPDATE public.idempotency_keys
  SET status = CASE WHEN p_ok THEN 'completed'::public.idempotency_status ELSE 'failed'::public.idempotency_status END,
      result = CASE WHEN p_ok THEN p_result ELSE NULL END,
      error_message = CASE WHEN p_ok THEN NULL ELSE left(coalesce(p_error,''), 500) END,
      completed_at = now()
  WHERE workspace_id = p_workspace_id AND key = p_key;
END $$;

REVOKE ALL ON FUNCTION public.idempotency_reserve(uuid,text,text,text,public.actor_type) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.idempotency_finish(uuid,text,boolean,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.idempotency_reserve(uuid,text,text,text,public.actor_type) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.idempotency_finish(uuid,text,boolean,jsonb,text) TO authenticated, service_role;

-- ============================================================
-- 4) WORKSPACES: no orphans, membership invariants
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users create workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Users can create workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "workspaces_insert" ON public.workspaces;
REVOKE INSERT ON public.workspaces FROM authenticated;

CREATE OR REPLACE FUNCTION public.create_workspace_with_owner(p_name text, p_slug text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  ws_id uuid;
  base text;
  candidate text;
  n int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN RAISE EXCEPTION 'name_required'; END IF;

  base := coalesce(nullif(regexp_replace(lower(coalesce(p_slug, p_name)), '[^a-z0-9]+', '-', 'g'), ''), 'ws');
  base := btrim(base, '-');
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM public.workspaces w WHERE w.slug = candidate) LOOP
    n := n + 1; candidate := base || '-' || n;
  END LOOP;

  INSERT INTO public.workspaces (name, slug) VALUES (btrim(p_name), candidate) RETURNING id INTO ws_id;
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES (ws_id, uid, 'owner');
  INSERT INTO public.activity_events (workspace_id, actor_type, actor_user_id, event_type, entity_type, entity_id, description)
  VALUES (ws_id, 'user', uid, 'workspace.created', 'workspace', ws_id, 'Espacio de trabajo creado');
  RETURN ws_id;
END $$;

REVOKE ALL ON FUNCTION public.create_workspace_with_owner(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace_with_owner(text,text) TO authenticated, service_role;

-- Membership invariants enforced in the database, not the UI.
ALTER TABLE public.workspace_members
  ADD CONSTRAINT workspace_members_unique UNIQUE (workspace_id, user_id);

CREATE OR REPLACE FUNCTION public.enforce_membership_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller uuid := auth.uid();
  caller_role public.workspace_role;
  ws uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
  owners int;
BEGIN
  -- Service-role / system paths (no auth.uid()) bypass caller checks but not
  -- the last-owner invariant.
  IF caller IS NOT NULL THEN
    SELECT role INTO caller_role FROM public.workspace_members
    WHERE workspace_id = ws AND user_id = caller;

    IF TG_OP = 'INSERT' THEN
      -- First member of a brand-new workspace must be its own owner.
      IF caller_role IS NULL THEN
        IF NOT (NEW.user_id = caller AND NEW.role = 'owner'
                AND NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = ws)) THEN
          RAISE EXCEPTION 'forbidden_membership_insert';
        END IF;
      ELSIF caller_role = 'admin' AND NEW.role = 'owner' THEN
        RAISE EXCEPTION 'admin_cannot_grant_owner';
      ELSIF caller_role = 'member' THEN
        RAISE EXCEPTION 'forbidden_membership_insert';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF caller_role IS NULL OR caller_role = 'member' THEN
        RAISE EXCEPTION 'forbidden_membership_update';
      END IF;
      IF caller_role = 'admin' AND (NEW.role = 'owner' OR OLD.role = 'owner') THEN
        RAISE EXCEPTION 'admin_cannot_change_owner';
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF caller_role IS NULL THEN
        RAISE EXCEPTION 'forbidden_membership_delete';
      END IF;
      IF caller_role = 'member' AND OLD.user_id <> caller THEN
        RAISE EXCEPTION 'forbidden_membership_delete';
      END IF;
      IF caller_role = 'admin' AND OLD.role = 'owner' THEN
        RAISE EXCEPTION 'admin_cannot_remove_owner';
      END IF;
    END IF;
  END IF;

  -- Last-owner invariant applies to every caller, including service_role.
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    SELECT count(*) INTO owners FROM public.workspace_members
    WHERE workspace_id = ws AND role = 'owner' AND user_id <> OLD.user_id;
    IF owners = 0 THEN RAISE EXCEPTION 'last_owner_protected'; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_membership_rules
BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_membership_rules();

-- ============================================================
-- 5) AI: relational run sources instead of a trust-me uuid[]
-- ============================================================
CREATE TABLE public.ai_run_sources (
  workspace_id uuid NOT NULL,
  ai_run_id uuid NOT NULL,
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ai_run_id, source_id),
  CONSTRAINT ai_run_sources_ws_run_fkey FOREIGN KEY (workspace_id, ai_run_id)
    REFERENCES public.ai_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_run_sources_ws_source_fkey FOREIGN KEY (workspace_id, source_id)
    REFERENCES public.sources (workspace_id, id) ON DELETE CASCADE
);

GRANT SELECT, INSERT ON public.ai_run_sources TO authenticated;
GRANT ALL ON public.ai_run_sources TO service_role;
ALTER TABLE public.ai_run_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read ai run sources" ON public.ai_run_sources
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY "Members link ai run sources" ON public.ai_run_sources
  FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));

INSERT INTO public.ai_run_sources (workspace_id, ai_run_id, source_id)
SELECT r.workspace_id, r.id, s.id
FROM public.ai_runs r
JOIN public.sources s ON s.id = ANY (r.input_source_ids) AND s.workspace_id = r.workspace_id
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN public.ai_runs.input_source_ids IS
  'DEPRECATED: superseded by public.ai_run_sources (composite FK enforced). Kept for backwards compatibility.';

-- ============================================================
-- 6) MCP credentials: hash only, never the token
-- ============================================================
ALTER TABLE public.mcp_integrations
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS token_prefix text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_token_hash ON public.mcp_integrations (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_prefix ON public.mcp_integrations (token_prefix);