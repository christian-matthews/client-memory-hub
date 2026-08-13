CREATE OR REPLACE FUNCTION public.create_manual_ingestion_item_v1(
  p_workspace_id uuid,
  p_client_id uuid,
  p_title text,
  p_transcript text,
  p_content_hash text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_item_id uuid;
  v_source_id uuid;
  v_title text;
  v_now timestamptz := now();
BEGIN
  IF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    PERFORM public.assert_workspace_access(p_workspace_id);
  END IF;

  IF p_transcript IS NULL OR length(btrim(p_transcript)) = 0 THEN
    RAISE EXCEPTION 'transcript_required';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'bad_request';
  END IF;

  v_title := NULLIF(btrim(coalesce(p_title, '')), '');
  IF v_title IS NULL THEN
    v_title := 'Reunión ' || to_char(v_now, 'DD/MM/YYYY HH24:MI');
  END IF;
  v_title := left(v_title, 300);

  INSERT INTO public.ingestion_items (
    workspace_id, connection_id, source_id, client_id, status, title,
    content_hash, occurred_at, participants, metadata
  ) VALUES (
    p_workspace_id, NULL, NULL, p_client_id,
    CASE WHEN p_client_id IS NULL THEN 'needs_client'::public.ingestion_status
         ELSE 'ready'::public.ingestion_status END,
    v_title, p_content_hash, v_now, '{}'::text[], coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (workspace_id, content_hash) DO NOTHING
  RETURNING id INTO v_item_id;

  IF v_item_id IS NULL THEN
    SELECT id INTO v_item_id FROM public.ingestion_items
    WHERE workspace_id = p_workspace_id AND content_hash = p_content_hash;
    RETURN jsonb_build_object('replayed', true, 'item_id', v_item_id);
  END IF;

  INSERT INTO public.sources (
    workspace_id, client_id, source_type, external_provider, external_id,
    title, content_text, occurred_at, metadata, content_hash, created_by
  ) VALUES (
    p_workspace_id, p_client_id, 'meeting', 'manual_paste', NULL,
    v_title, p_transcript, v_now, coalesce(p_metadata, '{}'::jsonb), p_content_hash, auth.uid()
  ) RETURNING id INTO v_source_id;

  UPDATE public.ingestion_items SET source_id = v_source_id WHERE id = v_item_id;

  PERFORM public.audit_write_internal(
    p_workspace_id, 'user'::public.actor_type, auth.uid(), NULL::text,
    jsonb_build_object(
      'eventType', 'ingestion_item.received',
      'entityType', 'ingestion_item',
      'entityId', v_item_id,
      'source', 'manual_paste',
      'clientId', p_client_id
    ),
    NULL::uuid
  );

  RETURN jsonb_build_object('replayed', false, 'item_id', v_item_id);
END $$;

REVOKE ALL ON FUNCTION public.create_manual_ingestion_item_v1(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_ingestion_item_v1(uuid, uuid, text, text, text, jsonb) TO authenticated, service_role;