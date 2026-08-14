-- 1. Normalized title (immutable expression, safe as generated column)
ALTER TABLE public.topics
  ADD COLUMN IF NOT EXISTS normalized_title text
  GENERATED ALWAYS AS (
    btrim(regexp_replace(lower(translate(title,
      'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
      'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
      '[^a-z0-9]+', ' ', 'g'), ' ')
  ) STORED;

-- 2. Merge pointer
ALTER TABLE public.topics
  ADD COLUMN IF NOT EXISTS merged_into_id uuid,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'topics_merged_into_fkey'
  ) THEN
    ALTER TABLE public.topics
      ADD CONSTRAINT topics_merged_into_fkey
      FOREIGN KEY (workspace_id, merged_into_id)
      REFERENCES public.topics (workspace_id, id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. One live topic per (client, normalized title)
CREATE UNIQUE INDEX IF NOT EXISTS topics_client_normalized_title_live_key
  ON public.topics (workspace_id, client_id, normalized_title)
  WHERE merged_into_id IS NULL
    AND archived_at IS NULL
    AND normalized_title <> '';

CREATE INDEX IF NOT EXISTS topics_merged_into_idx
  ON public.topics (workspace_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- 4. Transactional merge
CREATE OR REPLACE FUNCTION public.merge_topics_v1(
  p_workspace_id uuid,
  p_source_topic_id uuid,
  p_target_topic_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src public.topics;
  v_dst public.topics;
  v_now timestamptz := now();
  v_moved_updates int := 0;
  v_moved_commitments int := 0;
  v_moved_decisions int := 0;
  v_moved_sources int := 0;
BEGIN
  PERFORM public.assert_workspace_access(p_workspace_id);

  IF p_source_topic_id = p_target_topic_id THEN
    RAISE EXCEPTION 'same_topic';
  END IF;

  SELECT * INTO v_src FROM public.topics
  WHERE workspace_id = p_workspace_id AND id = p_source_topic_id FOR UPDATE;
  IF v_src.id IS NULL THEN RAISE EXCEPTION 'topic_not_found'; END IF;

  SELECT * INTO v_dst FROM public.topics
  WHERE workspace_id = p_workspace_id AND id = p_target_topic_id FOR UPDATE;
  IF v_dst.id IS NULL THEN RAISE EXCEPTION 'topic_not_found'; END IF;

  IF v_src.client_id <> v_dst.client_id THEN RAISE EXCEPTION 'different_client'; END IF;
  IF v_dst.merged_into_id IS NOT NULL THEN RAISE EXCEPTION 'target_already_merged'; END IF;
  IF v_src.merged_into_id IS NOT NULL THEN RAISE EXCEPTION 'source_already_merged'; END IF;

  UPDATE public.topic_updates SET topic_id = v_dst.id
  WHERE workspace_id = p_workspace_id AND topic_id = v_src.id;
  GET DIAGNOSTICS v_moved_updates = ROW_COUNT;

  UPDATE public.commitments SET topic_id = v_dst.id
  WHERE workspace_id = p_workspace_id AND topic_id = v_src.id;
  GET DIAGNOSTICS v_moved_commitments = ROW_COUNT;

  UPDATE public.decisions SET topic_id = v_dst.id
  WHERE workspace_id = p_workspace_id AND topic_id = v_src.id;
  GET DIAGNOSTICS v_moved_decisions = ROW_COUNT;

  INSERT INTO public.topic_sources (workspace_id, topic_id, source_id, relevance, linked_by)
  SELECT workspace_id, v_dst.id, source_id, relevance, linked_by
  FROM public.topic_sources
  WHERE workspace_id = p_workspace_id AND topic_id = v_src.id
  ON CONFLICT (topic_id, source_id) DO NOTHING;
  GET DIAGNOSTICS v_moved_sources = ROW_COUNT;

  DELETE FROM public.topic_sources
  WHERE workspace_id = p_workspace_id AND topic_id = v_src.id;

  UPDATE public.ai_proposals SET topic_id = v_dst.id
  WHERE workspace_id = p_workspace_id AND topic_id = v_src.id AND status = 'pending';

  UPDATE public.topics SET
    merged_into_id = v_dst.id,
    merged_at = v_now,
    status = 'archived',
    archived_at = coalesce(archived_at, v_now)
  WHERE workspace_id = p_workspace_id AND id = v_src.id;

  UPDATE public.topics SET
    last_relevant_change_at = v_now,
    current_state = CASE
      WHEN coalesce(btrim(v_dst.current_state), '') = '' THEN coalesce(v_src.current_state, '')
      ELSE v_dst.current_state END,
    blockers = coalesce(v_dst.blockers, v_src.blockers),
    next_step = coalesce(v_dst.next_step, v_src.next_step),
    next_step_owner = CASE WHEN v_dst.next_step IS NULL AND v_src.next_step IS NOT NULL
                           THEN v_src.next_step_owner ELSE v_dst.next_step_owner END,
    next_step_due_at = coalesce(v_dst.next_step_due_at, v_src.next_step_due_at)
  WHERE workspace_id = p_workspace_id AND id = v_dst.id;

  UPDATE public.clients SET last_relevant_activity_at = v_now
  WHERE workspace_id = p_workspace_id AND id = v_dst.client_id;

  PERFORM public.audit_write_internal(
    p_workspace_id, 'user'::public.actor_type, auth.uid(), NULL::text,
    jsonb_build_object(
      'eventType', 'topic.merged',
      'entityType', 'topic',
      'entityId', v_dst.id,
      'clientId', v_dst.client_id,
      'topicId', v_dst.id,
      'description', 'Tema “' || v_src.title || '” fusionado en “' || v_dst.title || '”',
      'inputSummary', left(v_src.title, 200),
      'metadata', jsonb_build_object(
        'sourceTopicId', v_src.id,
        'movedUpdates', v_moved_updates,
        'movedCommitments', v_moved_commitments,
        'movedDecisions', v_moved_decisions,
        'movedSources', v_moved_sources
      )
    ),
    NULL::uuid
  );

  RETURN jsonb_build_object(
    'targetTopicId', v_dst.id,
    'sourceTopicId', v_src.id,
    'movedUpdates', v_moved_updates,
    'movedCommitments', v_moved_commitments,
    'movedDecisions', v_moved_decisions,
    'movedSources', v_moved_sources
  );
END $function$;

REVOKE ALL ON FUNCTION public.merge_topics_v1(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_topics_v1(uuid, uuid, uuid) TO authenticated, service_role;