-- ============ ENUMS ============
CREATE TYPE public.workspace_role AS ENUM ('owner','admin','member');
CREATE TYPE public.relationship_status AS ENUM ('active','paused','archived');
CREATE TYPE public.client_health AS ENUM ('good','attention','risk','unknown');
CREATE TYPE public.topic_status AS ENUM ('active','waiting_client','pending_us','blocked','monitoring','resolved','archived');
CREATE TYPE public.priority_level AS ENUM ('high','medium','low');
CREATE TYPE public.party AS ENUM ('us','client','third_party','nobody');
CREATE TYPE public.responsible_party AS ENUM ('us','client','third_party');
CREATE TYPE public.commitment_status AS ENUM ('open','completed','cancelled','overdue');
CREATE TYPE public.update_type AS ENUM ('note','fact','decision','status_change','milestone');
CREATE TYPE public.source_type AS ENUM ('manual_note','email','meeting','document','api','other');
CREATE TYPE public.decision_status AS ENUM ('active','superseded');
CREATE TYPE public.actor_type AS ENUM ('user','ai','system','integration');
CREATE TYPE public.ai_run_status AS ENUM ('pending','running','completed','failed','cancelled');
CREATE TYPE public.ai_proposal_status AS ENUM ('pending','approved','rejected','applied','expired');

-- ============ SHARED TRIGGER ============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ============ WORKSPACES ============
CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workspace_members (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.workspace_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user ON public.workspace_members(user_id);

-- security-definer helpers (avoid recursive RLS)
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_members m
                 WHERE m.workspace_id = _workspace_id AND m.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.workspace_role_of(_workspace_id uuid)
RETURNS public.workspace_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.role FROM public.workspace_members m
  WHERE m.workspace_id = _workspace_id AND m.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(_workspace_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.workspace_role_of(_workspace_id) IN ('owner','admin');
$$;

-- idempotent, race-safe bootstrap of a personal workspace
CREATE OR REPLACE FUNCTION public.ensure_default_workspace()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  ws_id uuid;
  base_slug text;
  candidate text;
  n int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT workspace_id INTO ws_id FROM public.workspace_members
  WHERE user_id = uid ORDER BY created_at LIMIT 1;
  IF ws_id IS NOT NULL THEN RETURN ws_id; END IF;

  -- serialize per-user to avoid duplicate/orphan workspaces
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 42));

  SELECT workspace_id INTO ws_id FROM public.workspace_members
  WHERE user_id = uid ORDER BY created_at LIMIT 1;
  IF ws_id IS NOT NULL THEN RETURN ws_id; END IF;

  base_slug := 'ws-' || substr(replace(uid::text,'-',''), 1, 10);
  candidate := base_slug;
  WHILE EXISTS (SELECT 1 FROM public.workspaces w WHERE w.slug = candidate) LOOP
    n := n + 1;
    candidate := base_slug || '-' || n;
  END LOOP;

  INSERT INTO public.workspaces (name, slug) VALUES ('Mi espacio', candidate)
  RETURNING id INTO ws_id;
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES (ws_id, uid, 'owner');

  INSERT INTO public.activity_events (workspace_id, actor_type, actor_user_id, event_type, entity_type, entity_id, description)
  VALUES (ws_id, 'system', uid, 'workspace.created', 'workspace', ws_id, 'Espacio de trabajo inicial creado');

  RETURN ws_id;
END; $$;

-- ============ CLIENTS ============
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text,
  relationship_status public.relationship_status NOT NULL DEFAULT 'active',
  owner_user_id uuid,
  health public.client_health NOT NULL DEFAULT 'unknown',
  current_summary text,
  last_relevant_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX idx_clients_workspace ON public.clients(workspace_id, relationship_status);
CREATE UNIQUE INDEX uq_clients_workspace_name ON public.clients(workspace_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE public.client_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  email text,
  role text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX idx_client_contacts_client ON public.client_contacts(client_id);

-- ============ TOPICS ============
CREATE TABLE public.topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text,
  status public.topic_status NOT NULL DEFAULT 'active',
  priority public.priority_level NOT NULL DEFAULT 'medium',
  owner_user_id uuid,
  ball_with public.party NOT NULL DEFAULT 'us',
  current_state text NOT NULL DEFAULT '',
  next_step text,
  next_step_owner public.party NOT NULL DEFAULT 'nobody',
  next_step_due_at timestamptz,
  last_relevant_change_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  archived_at timestamptz
);
CREATE INDEX idx_topics_client ON public.topics(client_id, status);
CREATE INDEX idx_topics_workspace ON public.topics(workspace_id, status);

-- ============ COMMITMENTS ============
CREATE TABLE public.commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  responsible_party public.responsible_party NOT NULL,
  responsible_name text,
  status public.commitment_status NOT NULL DEFAULT 'open',
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX idx_commitments_client ON public.commitments(client_id, status);
CREATE INDEX idx_commitments_topic ON public.commitments(topic_id, status);
CREATE INDEX idx_commitments_due ON public.commitments(workspace_id, status, due_at);

-- ============ SOURCES (evidence) ============
CREATE TABLE public.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  source_type public.source_type NOT NULL DEFAULT 'manual_note',
  external_provider text,
  external_id text,
  title text,
  content_text text,
  occurred_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_sources_external ON public.sources(workspace_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX idx_sources_client ON public.sources(client_id, occurred_at DESC);
CREATE INDEX idx_sources_search ON public.sources USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content_text,'')));

CREATE TABLE public.topic_sources (
  topic_id uuid NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  relevance text,
  linked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, source_id)
);

-- ============ TOPIC UPDATES ============
CREATE TABLE public.topic_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
  update_type public.update_type NOT NULL DEFAULT 'note',
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 5000),
  is_relevant boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_topic_updates_topic ON public.topic_updates(topic_id, created_at DESC);
CREATE INDEX idx_topic_updates_client ON public.topic_updates(client_id, created_at DESC);

-- ============ DECISIONS ============
CREATE TABLE public.decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  decided_at timestamptz NOT NULL DEFAULT now(),
  status public.decision_status NOT NULL DEFAULT 'active',
  source_id uuid REFERENCES public.sources(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_decisions_client ON public.decisions(client_id, decided_at DESC);
CREATE INDEX idx_decisions_topic ON public.decisions(topic_id, decided_at DESC);

-- ============ ACTIVITY (append-only) ============
CREATE TABLE public.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  topic_id uuid REFERENCES public.topics(id) ON DELETE SET NULL,
  actor_type public.actor_type NOT NULL DEFAULT 'user',
  actor_user_id uuid,
  actor_name text,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  description text NOT NULL,
  input_summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_workspace ON public.activity_events(workspace_id, created_at DESC);
CREATE INDEX idx_activity_client ON public.activity_events(client_id, created_at DESC);
CREATE INDEX idx_activity_topic ON public.activity_events(topic_id, created_at DESC);
CREATE UNIQUE INDEX uq_activity_idempotency ON public.activity_events(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============ AI ============
CREATE TABLE public.ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  initiated_by_user_id uuid,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  status public.ai_run_status NOT NULL DEFAULT 'pending',
  input_source_ids uuid[] NOT NULL DEFAULT '{}',
  structured_output jsonb,
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_ai_runs_workspace ON public.ai_runs(workspace_id, created_at DESC);

CREATE TABLE public.ai_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ai_run_id uuid NOT NULL REFERENCES public.ai_runs(id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  topic_id uuid REFERENCES public.topics(id) ON DELETE CASCADE,
  proposal_type text NOT NULL,
  proposed_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation text NOT NULL,
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status public.ai_proposal_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_proposals_topic ON public.ai_proposals(topic_id, status);
CREATE INDEX idx_ai_proposals_workspace ON public.ai_proposals(workspace_id, status);

-- ============ MCP INTEGRATIONS ============
CREATE TABLE public.mcp_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  scopes text[] NOT NULL DEFAULT ARRAY['memory:read']::text[],
  write_enabled boolean NOT NULL DEFAULT false,
  created_by uuid,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mcp_integrations_workspace ON public.mcp_integrations(workspace_id);

-- ============ GRANTS ============
GRANT SELECT, INSERT, UPDATE ON public.workspaces TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_members TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.client_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.topics TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.commitments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sources TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.topic_sources TO authenticated;
GRANT SELECT, INSERT ON public.topic_updates TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.decisions TO authenticated;
GRANT SELECT, INSERT ON public.activity_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_proposals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mcp_integrations TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ============ RLS ============
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY ws_select ON public.workspaces FOR SELECT TO authenticated
  USING (public.is_workspace_member(id));
CREATE POLICY ws_insert ON public.workspaces FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY ws_update ON public.workspaces FOR UPDATE TO authenticated
  USING (public.is_workspace_admin(id)) WITH CHECK (public.is_workspace_admin(id));

CREATE POLICY wm_select ON public.workspace_members FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));
CREATE POLICY wm_insert ON public.workspace_members FOR INSERT TO authenticated
  WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY wm_update ON public.workspace_members FOR UPDATE TO authenticated
  USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY wm_delete ON public.workspace_members FOR DELETE TO authenticated
  USING (public.is_workspace_admin(workspace_id));

CREATE POLICY clients_select ON public.clients FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY clients_insert ON public.clients FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY clients_update ON public.clients FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY contacts_select ON public.client_contacts FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY contacts_insert ON public.client_contacts FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY contacts_update ON public.client_contacts FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY topics_select ON public.topics FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY topics_insert ON public.topics FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY topics_update ON public.topics FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY commitments_select ON public.commitments FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY commitments_insert ON public.commitments FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY commitments_update ON public.commitments FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY sources_select ON public.sources FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY sources_insert ON public.sources FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY sources_update ON public.sources FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY topic_sources_select ON public.topic_sources FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY topic_sources_insert ON public.topic_sources FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY topic_sources_delete ON public.topic_sources FOR DELETE TO authenticated USING (public.is_workspace_member(workspace_id));

CREATE POLICY updates_select ON public.topic_updates FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY updates_insert ON public.topic_updates FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY decisions_select ON public.decisions FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY decisions_insert ON public.decisions FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY decisions_update ON public.decisions FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY activity_select ON public.activity_events FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY activity_insert ON public.activity_events FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY ai_runs_select ON public.ai_runs FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY ai_runs_insert ON public.ai_runs FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY ai_runs_update ON public.ai_runs FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY ai_proposals_select ON public.ai_proposals FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY ai_proposals_insert ON public.ai_proposals FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY ai_proposals_update ON public.ai_proposals FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY mcp_select ON public.mcp_integrations FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY mcp_insert ON public.mcp_integrations FOR INSERT TO authenticated WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY mcp_update ON public.mcp_integrations FOR UPDATE TO authenticated USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));

-- ============ updated_at TRIGGERS ============
CREATE TRIGGER trg_workspaces_updated BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_workspace_members_updated BEFORE UPDATE ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_clients_updated BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON public.client_contacts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_topics_updated BEFORE UPDATE ON public.topics FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_commitments_updated BEFORE UPDATE ON public.commitments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_mcp_updated BEFORE UPDATE ON public.mcp_integrations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();