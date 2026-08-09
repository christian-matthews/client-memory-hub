-- ============================================================
-- P4: composite FKs must never try to NULL workspace_id
-- ============================================================
ALTER TABLE public.activity_events DROP CONSTRAINT IF EXISTS activity_events_ws_client_fkey;
ALTER TABLE public.activity_events ADD CONSTRAINT activity_events_ws_client_fkey
  FOREIGN KEY (workspace_id, client_id) REFERENCES public.clients(workspace_id, id)
  ON DELETE SET NULL (client_id);

ALTER TABLE public.activity_events DROP CONSTRAINT IF EXISTS activity_events_ws_topic_fkey;
ALTER TABLE public.activity_events ADD CONSTRAINT activity_events_ws_topic_fkey
  FOREIGN KEY (workspace_id, topic_id) REFERENCES public.topics(workspace_id, id)
  ON DELETE SET NULL (topic_id);

ALTER TABLE public.decisions DROP CONSTRAINT IF EXISTS decisions_ws_source_fkey;
ALTER TABLE public.decisions ADD CONSTRAINT decisions_ws_source_fkey
  FOREIGN KEY (workspace_id, source_id) REFERENCES public.sources(workspace_id, id)
  ON DELETE SET NULL (source_id);

ALTER TABLE public.sources DROP CONSTRAINT IF EXISTS sources_ws_client_fkey;
ALTER TABLE public.sources ADD CONSTRAINT sources_ws_client_fkey
  FOREIGN KEY (workspace_id, client_id) REFERENCES public.clients(workspace_id, id)
  ON DELETE SET NULL (client_id);
ALTER TABLE public.sources DROP CONSTRAINT IF EXISTS sources_client_id_fkey;

-- ============================================================
-- P1: audit trail is no longer writable from the browser
-- ============================================================
DROP POLICY IF EXISTS activity_insert ON public.activity_events;
REVOKE INSERT ON public.activity_events FROM authenticated;
REVOKE INSERT ON public.activity_events FROM anon;

-- Trusted-workspace escape hatch used only by SECURITY DEFINER cores below.
CREATE OR REPLACE FUNCTION public.assert_workspace_access(_workspace_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
BEGIN
  IF _workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_required'; END IF;
  IF current_setting('app.workspace_trusted', true) = _workspace_id::text THEN RETURN; END IF;
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.workspace_members m
                   WHERE m.workspace_id = _workspace_id AND m.user_id = auth.uid()) THEN
      RAISE EXCEPTION 'forbidden_workspace';
    END IF;
  ELSIF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_workspace';
  END IF;
END $$;

-- Internal audit writer. Never callable with a caller-chosen human identity.
CREATE OR REPLACE FUNCTION public.audit_write_internal(
  p_workspace_id uuid,
  p_actor_type public.actor_type,
  p_actor_user_id uuid,
  p_actor_name text,
  p_event jsonb,
  p_correlation_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.activity_events (
    workspace_id, client_id, topic_id, actor_type, actor_user_id, actor_name,
    event_type, entity_type, entity_id, description, input_summary, metadata,
    correlation_id, idempotency_key
  ) VALUES (
    p_workspace_id,
    NULLIF(p_event->>'clientId','')::uuid,
    NULLIF(p_event->>'topicId','')::uuid,
    p_actor_type, p_actor_user_id, p_actor_name,
    p_event->>'eventType', p_event->>'entityType',
    NULLIF(p_event->>'entityId','')::uuid,
    p_event->>'description',
    left(coalesce(p_event->>'inputSummary',''), 500),
    coalesce(p_event->'metadata', '{}'::jsonb),
    coalesce(p_correlation_id, gen_random_uuid()),
    NULLIF(p_event->>'idempotencyKey','')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.audit_write_internal(uuid, public.actor_type, uuid, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_write_internal(uuid, public.actor_type, uuid, text, jsonb, uuid) FROM authenticated, anon;

-- Public entry point. Humans get actor_type='user' + auth.uid(); privileged
-- callers (service_role) may log ai/integration/system events.
CREATE OR REPLACE FUNCTION public.record_activity_v1(
  p_workspace_id uuid,
  p_event jsonb,
  p_actor_type public.actor_type DEFAULT 'user',
  p_actor_name text DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF p_workspace_id IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;
  IF p_event->>'eventType' IS NULL OR p_event->>'entityType' IS NULL OR p_event->>'description' IS NULL THEN
    RAISE EXCEPTION 'bad_request';
  END IF;

  IF uid IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.workspace_members m
                   WHERE m.workspace_id = p_workspace_id AND m.user_id = uid) THEN
      RAISE EXCEPTION 'forbidden_workspace';
    END IF;
    -- Human callers cannot choose actor identity at all.
    RETURN public.audit_write_internal(p_workspace_id, 'user', uid, NULL, p_event, p_correlation_id);
  END IF;

  IF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_actor';
  END IF;
  IF p_actor_type = 'user' THEN RAISE EXCEPTION 'forbidden_actor'; END IF;
  RETURN public.audit_write_internal(p_workspace_id, p_actor_type, NULL, p_actor_name, p_event, p_correlation_id);
END $$;
REVOKE ALL ON FUNCTION public.record_activity_v1(uuid, jsonb, public.actor_type, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_activity_v1(uuid, jsonb, public.actor_type, text, uuid) TO authenticated, service_role;

-- ============================================================
-- P3: idempotency plumbing is internal only
-- ============================================================
ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS integration_id uuid;

REVOKE ALL ON FUNCTION public.idempotency_reserve(uuid, text, text, text, public.actor_type) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idempotency_reserve(uuid, text, text, text, public.actor_type) FROM authenticated, anon;
REVOKE ALL ON FUNCTION public.idempotency_finish(uuid, text, boolean, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idempotency_finish(uuid, text, boolean, jsonb, text) FROM authenticated, anon;
REVOKE ALL ON FUNCTION public.add_topic_update_tx(
  uuid, uuid, text, public.update_type, boolean, public.topic_status, public.party, text,
  boolean, text, public.party, timestamptz, text, jsonb, uuid, public.actor_type, uuid, text,
  text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_topic_update_tx(
  uuid, uuid, text, public.update_type, boolean, public.topic_status, public.party, text,
  boolean, text, public.party, timestamptz, text, jsonb, uuid, public.actor_type, uuid, text,
  text, uuid, text, text) FROM authenticated, anon;

-- ============================================================
-- P2: one transaction = reserve + mutate + audit + store + finish
-- ============================================================
CREATE OR REPLACE FUNCTION public.domain_write_core(
  p_workspace_id uuid,
  p_operation text,
  p_payload jsonb,
  p_actor_type public.actor_type,
  p_actor_user_id uuid,
  p_actor_name text,
  p_correlation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_now timestamptz := now();
  v_client public.clients;
  v_topic public.topics;
  v_commitment public.commitments;
  v_id uuid;
  v_result jsonb;
BEGIN
  PERFORM set_config('app.workspace_trusted', p_workspace_id::text, true);

  IF p_operation = 'create_client' THEN
    INSERT INTO public.clients (workspace_id, name, description, owner_user_id, current_summary)
    VALUES (p_workspace_id, p_payload->>'name', NULLIF(p_payload->>'description',''),
            coalesce(NULLIF(p_payload->>'ownerUserId','')::uuid, p_actor_user_id),
            NULLIF(p_payload->>'currentSummary',''))
    RETURNING * INTO v_client;
    PERFORM public.audit_write_internal(p_workspace_id, p_actor_type, p_actor_user_id, p_actor_name,
      jsonb_build_object('eventType','client.created','entityType','client','entityId',v_client.id,
        'clientId',v_client.id,'description','Cliente creado: '||v_client.name,
        'inputSummary',v_client.name), p_correlation_id);
    v_result := jsonb_build_object('clientId', v_client.id, 'replayed', false);

  ELSIF p_operation = 'create_topic' THEN
    SELECT * INTO v_client FROM public.clients
    WHERE workspace_id = p_workspace_id AND id = (p_payload->>'clientId')::uuid;
    IF v_client.id IS NULL THEN RAISE EXCEPTION 'client_not_found'; END IF;

    INSERT INTO public.topics (workspace_id, client_id, title, description, status, priority,
      owner_user_id, ball_with, current_state, next_step, next_step_owner, next_step_due_at,
      last_relevant_change_at)
    VALUES (p_workspace_id, v_client.id, p_payload->>'title', NULLIF(p_payload->>'description',''),
      coalesce(NULLIF(p_payload->>'status','')::public.topic_status, 'active'),
      coalesce(NULLIF(p_payload->>'priority','')::public.priority_level, 'medium'),
      p_actor_user_id,
      coalesce(NULLIF(p_payload->>'ballWith','')::public.party, 'us'),
      coalesce(p_payload->>'currentState',''),
      NULLIF(p_payload->>'nextStep',''),
      coalesce(NULLIF(p_payload->>'nextStepOwner','')::public.party, 'nobody'),
      NULLIF(p_payload->>'nextStepDueAt','')::timestamptz, v_now)
    RETURNING * INTO v_topic;

    UPDATE public.clients SET last_relevant_activity_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_client.id;

    PERFORM public.audit_write_internal(p_workspace_id, p_actor_type, p_actor_user_id, p_actor_name,
      jsonb_build_object('eventType','topic.created','entityType','topic','entityId',v_topic.id,
        'clientId',v_client.id,'topicId',v_topic.id,
        'description','Tema creado para '||v_client.name||': '||v_topic.title,
        'inputSummary',v_topic.title), p_correlation_id);
    v_result := jsonb_build_object('topicId', v_topic.id, 'clientId', v_client.id, 'replayed', false);

  ELSIF p_operation = 'add_topic_update' THEN
    v_result := public.add_topic_update_tx(
      p_workspace_id, (p_payload->>'topicId')::uuid, p_payload->>'content',
      coalesce(NULLIF(p_payload->>'updateType','')::public.update_type,'note'),
      coalesce((p_payload->>'isRelevant')::boolean, true),
      NULLIF(p_payload->>'status','')::public.topic_status,
      NULLIF(p_payload->>'ballWith','')::public.party,
      NULLIF(p_payload->>'currentState',''),
      (p_payload ? 'nextStep'),
      NULLIF(p_payload->>'nextStep',''),
      coalesce(NULLIF(p_payload->>'nextStepOwner','')::public.party,'nobody'),
      NULLIF(p_payload->>'nextStepDueAt','')::timestamptz,
      NULLIF(p_payload->>'decision',''),
      p_payload->'commitment',
      NULLIF(p_payload->>'sourceId','')::uuid,
      p_actor_type, p_actor_user_id, p_actor_name, NULL, p_correlation_id, NULL, ''
    );

  ELSIF p_operation = 'set_topic_next_step' THEN
    SELECT * INTO v_topic FROM public.topics
    WHERE workspace_id = p_workspace_id AND id = (p_payload->>'topicId')::uuid;
    IF v_topic.id IS NULL THEN RAISE EXCEPTION 'topic_not_found'; END IF;

    UPDATE public.topics SET
      next_step = NULLIF(p_payload->>'nextStep',''),
      next_step_owner = coalesce(NULLIF(p_payload->>'nextStepOwner','')::public.party,'nobody'),
      next_step_due_at = NULLIF(p_payload->>'nextStepDueAt','')::timestamptz,
      last_relevant_change_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_topic.id;

    UPDATE public.clients SET last_relevant_activity_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_topic.client_id;

    PERFORM public.audit_write_internal(p_workspace_id, p_actor_type, p_actor_user_id, p_actor_name,
      jsonb_build_object('eventType','topic.next_step_set','entityType','topic','entityId',v_topic.id,
        'clientId',v_topic.client_id,'topicId',v_topic.id,
        'description','Próximo paso de “'||v_topic.title||'”: '||coalesce(NULLIF(p_payload->>'nextStep',''),'sin definir')),
      p_correlation_id);
    v_result := jsonb_build_object('topicId', v_topic.id, 'replayed', false);

  ELSIF p_operation = 'create_commitment' THEN
    SELECT * INTO v_topic FROM public.topics
    WHERE workspace_id = p_workspace_id AND id = (p_payload->>'topicId')::uuid;
    IF v_topic.id IS NULL THEN RAISE EXCEPTION 'topic_not_found'; END IF;

    INSERT INTO public.commitments (workspace_id, client_id, topic_id, description,
      responsible_party, responsible_name, due_at)
    VALUES (p_workspace_id, v_topic.client_id, v_topic.id, p_payload->>'description',
      (p_payload->>'responsibleParty')::public.responsible_party,
      NULLIF(p_payload->>'responsibleName',''),
      NULLIF(p_payload->>'dueAt','')::timestamptz)
    RETURNING id INTO v_id;

    UPDATE public.clients SET last_relevant_activity_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_topic.client_id;

    PERFORM public.audit_write_internal(p_workspace_id, p_actor_type, p_actor_user_id, p_actor_name,
      jsonb_build_object('eventType','commitment.created','entityType','commitment','entityId',v_id,
        'clientId',v_topic.client_id,'topicId',v_topic.id,
        'description','Compromiso creado en “'||v_topic.title||'”',
        'inputSummary',left(p_payload->>'description',200)), p_correlation_id);
    v_result := jsonb_build_object('commitmentId', v_id, 'topicId', v_topic.id, 'replayed', false);

  ELSIF p_operation = 'complete_commitment' THEN
    SELECT * INTO v_commitment FROM public.commitments
    WHERE workspace_id = p_workspace_id AND id = (p_payload->>'commitmentId')::uuid;
    IF v_commitment.id IS NULL THEN RAISE EXCEPTION 'commitment_not_found'; END IF;

    IF v_commitment.status <> 'completed' THEN
      UPDATE public.commitments SET status = 'completed', completed_at = v_now
      WHERE workspace_id = p_workspace_id AND id = v_commitment.id;
      UPDATE public.clients SET last_relevant_activity_at = v_now
      WHERE workspace_id = p_workspace_id AND id = v_commitment.client_id;
      PERFORM public.audit_write_internal(p_workspace_id, p_actor_type, p_actor_user_id, p_actor_name,
        jsonb_build_object('eventType','commitment.completed','entityType','commitment',
          'entityId',v_commitment.id,'clientId',v_commitment.client_id,'topicId',v_commitment.topic_id,
          'description','Compromiso cumplido: '||left(v_commitment.description,120)), p_correlation_id);
    END IF;
    v_result := jsonb_build_object('commitmentId', v_commitment.id, 'replayed', false);

  ELSE
    RAISE EXCEPTION 'unsupported_operation';
  END IF;

  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.domain_write_core(uuid, text, jsonb, public.actor_type, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.domain_write_core(uuid, text, jsonb, public.actor_type, uuid, text, uuid) FROM authenticated, anon;

-- Guarded wrapper: idempotency reservation, execution, audit and result storage
-- all inside this single function call (= single transaction).
CREATE OR REPLACE FUNCTION public.domain_write_guarded(
  p_workspace_id uuid,
  p_operation text,
  p_payload jsonb,
  p_request_hash text,
  p_idempotency_key text,
  p_actor_type public.actor_type,
  p_actor_user_id uuid,
  p_actor_name text,
  p_integration_id uuid,
  p_correlation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_existing public.idempotency_keys;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RETURN public.domain_write_core(p_workspace_id, p_operation, p_payload, p_actor_type,
                                    p_actor_user_id, p_actor_name, p_correlation_id);
  END IF;

  INSERT INTO public.idempotency_keys
    (workspace_id, key, operation, actor_type, request_hash, actor_user_id, integration_id)
  VALUES (p_workspace_id, p_idempotency_key, p_operation, p_actor_type,
          coalesce(p_request_hash,''), p_actor_user_id, p_integration_id)
  ON CONFLICT (workspace_id, key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_existing FROM public.idempotency_keys
    WHERE workspace_id = p_workspace_id AND key = p_idempotency_key FOR UPDATE;

    -- A key belongs to one operation and to the identity that created it.
    IF v_existing.operation <> p_operation
       OR v_existing.request_hash <> coalesce(p_request_hash,'')
       OR coalesce(v_existing.actor_user_id::text,'-') <> coalesce(p_actor_user_id::text,'-')
       OR coalesce(v_existing.integration_id::text,'-') <> coalesce(p_integration_id::text,'-') THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;

    IF v_existing.status = 'completed' THEN
      RETURN jsonb_set(coalesce(v_existing.result,'{}'::jsonb), '{replayed}', 'true'::jsonb);
    END IF;

    UPDATE public.idempotency_keys
    SET status = 'in_progress', error_message = NULL, created_at = now()
    WHERE workspace_id = p_workspace_id AND key = p_idempotency_key;
  END IF;

  v_result := public.domain_write_core(p_workspace_id, p_operation, p_payload, p_actor_type,
                                       p_actor_user_id, p_actor_name, p_correlation_id);

  UPDATE public.idempotency_keys
  SET status = 'completed', result = v_result, completed_at = now(), error_message = NULL
  WHERE workspace_id = p_workspace_id AND key = p_idempotency_key;

  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.domain_write_guarded(uuid, text, jsonb, text, text, public.actor_type, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.domain_write_guarded(uuid, text, jsonb, text, text, public.actor_type, uuid, text, uuid, uuid) FROM authenticated, anon;

-- Public entry point for signed-in humans: actor is always auth.uid()/user.
CREATE OR REPLACE FUNCTION public.domain_write(
  p_workspace_id uuid,
  p_operation text,
  p_payload jsonb,
  p_request_hash text DEFAULT '',
  p_idempotency_key text DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m
                 WHERE m.workspace_id = p_workspace_id AND m.user_id = uid) THEN
    RAISE EXCEPTION 'forbidden_workspace';
  END IF;
  RETURN public.domain_write_guarded(p_workspace_id, p_operation, p_payload, p_request_hash,
    p_idempotency_key, 'user', uid, NULL, NULL, p_correlation_id);
END $$;
REVOKE ALL ON FUNCTION public.domain_write(uuid, text, jsonb, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.domain_write(uuid, text, jsonb, text, text, uuid) TO authenticated, service_role;

-- Privileged entry point for MCP: workspace and scopes come from the credential.
CREATE OR REPLACE FUNCTION public.domain_write_as_integration(
  p_integration_id uuid,
  p_operation text,
  p_payload jsonb,
  p_request_hash text DEFAULT '',
  p_idempotency_key text DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_i public.mcp_integrations;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'forbidden_actor'; END IF;
  IF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_actor';
  END IF;

  SELECT * INTO v_i FROM public.mcp_integrations WHERE id = p_integration_id;
  IF v_i.id IS NULL THEN RAISE EXCEPTION 'invalid_credential'; END IF;
  IF v_i.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_credential'; END IF;
  IF v_i.expires_at IS NOT NULL AND v_i.expires_at < now() THEN RAISE EXCEPTION 'invalid_credential'; END IF;
  IF NOT (v_i.write_enabled AND 'write' = ANY(v_i.scopes)) THEN RAISE EXCEPTION 'read_only_integration'; END IF;

  RETURN public.domain_write_guarded(v_i.workspace_id, p_operation, p_payload, p_request_hash,
    p_idempotency_key, 'integration', NULL, v_i.name, v_i.id, p_correlation_id);
END $$;
REVOKE ALL ON FUNCTION public.domain_write_as_integration(uuid, text, jsonb, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.domain_write_as_integration(uuid, text, jsonb, text, text, uuid) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.domain_write_as_integration(uuid, text, jsonb, text, text, uuid) TO service_role;