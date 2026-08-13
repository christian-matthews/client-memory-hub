ALTER TYPE public.topic_status ADD VALUE IF NOT EXISTS 'paused';

ALTER TABLE public.topics
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS client_owner_name text,
  ADD COLUMN IF NOT EXISTS blockers text;

ALTER TABLE public.topic_updates
  ADD COLUMN IF NOT EXISTS source_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'topic_updates_source_ws_fkey'
      AND conrelid = 'public.topic_updates'::regclass
  ) THEN
    ALTER TABLE public.topic_updates
      ADD CONSTRAINT topic_updates_source_ws_fkey
      FOREIGN KEY (workspace_id, source_id)
      REFERENCES public.sources (workspace_id, id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS topic_updates_source_idx
  ON public.topic_updates (workspace_id, source_id);