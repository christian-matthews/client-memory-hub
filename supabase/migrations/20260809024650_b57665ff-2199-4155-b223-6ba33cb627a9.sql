CREATE TYPE public.ingestion_status AS ENUM ('received','processing','processed','failed','discarded');

CREATE TABLE public.ingestion_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'macwhisper',
  secret_hash text NOT NULL,
  secret_prefix text NOT NULL,
  default_client_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_connections_ws_id_key UNIQUE (workspace_id, id),
  CONSTRAINT ingestion_connections_client_fk FOREIGN KEY (workspace_id, default_client_id)
    REFERENCES public.clients(workspace_id, id) ON DELETE SET NULL (default_client_id)
);

CREATE UNIQUE INDEX ingestion_connections_secret_hash_key ON public.ingestion_connections(secret_hash);
CREATE INDEX ingestion_connections_workspace_idx ON public.ingestion_connections(workspace_id);

GRANT SELECT ON public.ingestion_connections TO authenticated;
GRANT INSERT, UPDATE ON public.ingestion_connections TO authenticated;
GRANT ALL ON public.ingestion_connections TO service_role;

ALTER TABLE public.ingestion_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingestion_connections_select_members" ON public.ingestion_connections
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY "ingestion_connections_insert_admins" ON public.ingestion_connections
  FOR INSERT TO authenticated WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY "ingestion_connections_update_admins" ON public.ingestion_connections
  FOR UPDATE TO authenticated USING (public.is_workspace_admin(workspace_id))
  WITH CHECK (public.is_workspace_admin(workspace_id));

CREATE TRIGGER ingestion_connections_set_updated_at
  BEFORE UPDATE ON public.ingestion_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.ingestion_items (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id uuid,
  source_id uuid,
  client_id uuid,
  status public.ingestion_status NOT NULL DEFAULT 'received',
  title text,
  external_id text,
  content_hash text NOT NULL,
  occurred_at timestamptz,
  duration_seconds integer,
  participants text[] NOT NULL DEFAULT '{}',
  language text,
  ai_run_id uuid,
  proposal_count integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_items_ws_id_key UNIQUE (workspace_id, id),
  CONSTRAINT ingestion_items_ws_content_key UNIQUE (workspace_id, content_hash),
  CONSTRAINT ingestion_items_connection_fk FOREIGN KEY (workspace_id, connection_id)
    REFERENCES public.ingestion_connections(workspace_id, id) ON DELETE SET NULL (connection_id),
  CONSTRAINT ingestion_items_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES public.sources(workspace_id, id) ON DELETE SET NULL (source_id),
  CONSTRAINT ingestion_items_client_fk FOREIGN KEY (workspace_id, client_id)
    REFERENCES public.clients(workspace_id, id) ON DELETE SET NULL (client_id),
  CONSTRAINT ingestion_items_ai_run_fk FOREIGN KEY (workspace_id, ai_run_id)
    REFERENCES public.ai_runs(workspace_id, id) ON DELETE SET NULL (ai_run_id)
);

CREATE INDEX ingestion_items_workspace_status_idx ON public.ingestion_items(workspace_id, status, created_at DESC);
CREATE INDEX ingestion_items_client_idx ON public.ingestion_items(workspace_id, client_id);

GRANT SELECT, UPDATE ON public.ingestion_items TO authenticated;
GRANT ALL ON public.ingestion_items TO service_role;

ALTER TABLE public.ingestion_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingestion_items_select_members" ON public.ingestion_items
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY "ingestion_items_update_admins" ON public.ingestion_items
  FOR UPDATE TO authenticated USING (public.is_workspace_admin(workspace_id))
  WITH CHECK (public.is_workspace_admin(workspace_id));

CREATE TRIGGER ingestion_items_set_updated_at
  BEFORE UPDATE ON public.ingestion_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();