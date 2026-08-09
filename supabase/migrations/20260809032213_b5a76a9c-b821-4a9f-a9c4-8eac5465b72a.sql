ALTER TYPE public.ingestion_status ADD VALUE IF NOT EXISTS 'needs_client' BEFORE 'processing';
ALTER TYPE public.ingestion_status ADD VALUE IF NOT EXISTS 'ready' BEFORE 'processing';
ALTER TYPE public.ingestion_status ADD VALUE IF NOT EXISTS 'needs_review' AFTER 'processing';

ALTER TABLE public.ingestion_items
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

ALTER TABLE public.ai_proposals
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS edited_by uuid,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.source_derivatives (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  ai_run_id uuid,
  derivative_type text NOT NULL DEFAULT 'meeting_summary',
  content_text text NOT NULL,
  language text,
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_derivatives_ws_id_key UNIQUE (workspace_id, id),
  CONSTRAINT source_derivatives_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES public.sources(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT source_derivatives_ai_run_fk FOREIGN KEY (workspace_id, ai_run_id)
    REFERENCES public.ai_runs(workspace_id, id) ON DELETE SET NULL (ai_run_id)
);

CREATE INDEX IF NOT EXISTS source_derivatives_source_idx
  ON public.source_derivatives(workspace_id, source_id, created_at DESC);

GRANT SELECT ON public.source_derivatives TO authenticated;
GRANT ALL ON public.source_derivatives TO service_role;

ALTER TABLE public.source_derivatives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "source_derivatives_select_members" ON public.source_derivatives;
CREATE POLICY "source_derivatives_select_members" ON public.source_derivatives
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));