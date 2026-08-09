-- 1) Guard: fail loudly if any existing row crosses workspaces.
DO $$
DECLARE bad int;
BEGIN
  SELECT
    (SELECT count(*) FROM public.client_contacts x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.topics x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.commitments x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.commitments x JOIN public.topics c ON c.id=x.topic_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.topic_updates x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.topic_updates x JOIN public.topics c ON c.id=x.topic_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.decisions x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.decisions x JOIN public.topics c ON c.id=x.topic_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.decisions x JOIN public.sources c ON c.id=x.source_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.sources x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.topic_sources x JOIN public.topics c ON c.id=x.topic_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.topic_sources x JOIN public.sources c ON c.id=x.source_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.activity_events x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.activity_events x JOIN public.topics c ON c.id=x.topic_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.ai_proposals x JOIN public.ai_runs c ON c.id=x.ai_run_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.ai_proposals x JOIN public.clients c ON c.id=x.client_id WHERE c.workspace_id<>x.workspace_id)
  + (SELECT count(*) FROM public.ai_proposals x JOIN public.topics c ON c.id=x.topic_id WHERE c.workspace_id<>x.workspace_id)
  INTO bad;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Cross-workspace inconsistencies detected (% rows). Repair data before applying composite foreign keys; no rows were modified.', bad;
  END IF;
END $$;

-- 2) Composite unique keys required as FK targets.
ALTER TABLE public.clients  ADD CONSTRAINT clients_workspace_id_key  UNIQUE (workspace_id, id);
ALTER TABLE public.topics   ADD CONSTRAINT topics_workspace_id_key   UNIQUE (workspace_id, id);
ALTER TABLE public.sources  ADD CONSTRAINT sources_workspace_id_key  UNIQUE (workspace_id, id);
ALTER TABLE public.ai_runs  ADD CONSTRAINT ai_runs_workspace_id_key  UNIQUE (workspace_id, id);

-- 3) Composite foreign keys (complement the existing single-column FKs).
ALTER TABLE public.client_contacts
  ADD CONSTRAINT client_contacts_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.topics
  ADD CONSTRAINT topics_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.commitments
  ADD CONSTRAINT commitments_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT commitments_ws_topic_fkey FOREIGN KEY (workspace_id, topic_id)
  REFERENCES public.topics (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.topic_updates
  ADD CONSTRAINT topic_updates_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT topic_updates_ws_topic_fkey FOREIGN KEY (workspace_id, topic_id)
  REFERENCES public.topics (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.decisions
  ADD CONSTRAINT decisions_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT decisions_ws_topic_fkey FOREIGN KEY (workspace_id, topic_id)
  REFERENCES public.topics (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT decisions_ws_source_fkey FOREIGN KEY (workspace_id, source_id)
  REFERENCES public.sources (workspace_id, id) ON DELETE SET NULL;

ALTER TABLE public.sources
  ADD CONSTRAINT sources_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.topic_sources
  ADD CONSTRAINT topic_sources_ws_topic_fkey FOREIGN KEY (workspace_id, topic_id)
  REFERENCES public.topics (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT topic_sources_ws_source_fkey FOREIGN KEY (workspace_id, source_id)
  REFERENCES public.sources (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.activity_events
  ADD CONSTRAINT activity_events_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE SET NULL,
  ADD CONSTRAINT activity_events_ws_topic_fkey FOREIGN KEY (workspace_id, topic_id)
  REFERENCES public.topics (workspace_id, id) ON DELETE SET NULL;

ALTER TABLE public.ai_proposals
  ADD CONSTRAINT ai_proposals_ws_run_fkey FOREIGN KEY (workspace_id, ai_run_id)
  REFERENCES public.ai_runs (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT ai_proposals_ws_client_fkey FOREIGN KEY (workspace_id, client_id)
  REFERENCES public.clients (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT ai_proposals_ws_topic_fkey FOREIGN KEY (workspace_id, topic_id)
  REFERENCES public.topics (workspace_id, id) ON DELETE CASCADE;

-- 4) Supporting indexes for the new composite FK columns.
CREATE INDEX IF NOT EXISTS idx_topic_sources_ws_source ON public.topic_sources (workspace_id, source_id);
CREATE INDEX IF NOT EXISTS idx_decisions_ws_source ON public.decisions (workspace_id, source_id);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_ws_run ON public.ai_proposals (workspace_id, ai_run_id);