-- ============================================================
-- Transactional MacWhisper reception
-- ============================================================
CREATE OR REPLACE FUNCTION public.receive_macwhisper_transcript_v1(
  p_connection_id uuid,
  p_secret_hash text,
  p_title text,
  p_transcript text,
  p_content_hash text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_correlation_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_conn public.ingestion_connections;
  v_item_id uuid;
  v_source_id uuid;
  v_title text;
  v_now timestamptz := now();
BEGIN
  IF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_actor';
  END IF;
  IF p_transcript IS NULL OR length(btrim(p_transcript)) = 0 THEN
    RAISE EXCEPTION 'transcript_required';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'bad_request';
  END IF;

  -- Row lock serialises concurrent webhooks for the same connection.
  SELECT * INTO v_conn FROM public.ingestion_connections
  WHERE id = p_connection_id AND secret_hash = p_secret_hash
  FOR UPDATE;

  IF v_conn.id IS NULL OR v_conn.revoked_at IS NOT NULL OR v_conn.enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid_credential';
  END IF;

  v_title := NULLIF(btrim(coalesce(p_title, '')), '');
  IF v_title IS NULL THEN
    v_title := 'Reunión ' || to_char(v_now, 'DD/MM/YYYY HH24:MI');
  END IF;
  v_title := left(v_title, 300);

  -- Claim the content hash first: the unique (workspace_id, content_hash)
  -- constraint makes a concurrent replay a no-op instead of a duplicate.
  INSERT INTO public.ingestion_items (
    workspace_id, connection_id, source_id, client_id, status, title,
    content_hash, occurred_at, participants, metadata
  ) VALUES (
    v_conn.workspace_id, v_conn.id, NULL, v_conn.default_client_id,
    CASE WHEN v_conn.default_client_id IS NULL THEN 'needs_client'::public.ingestion_status
         ELSE 'ready'::public.ingestion_status END,
    v_title, p_content_hash, v_now, '{}'::text[], coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (workspace_id, content_hash) DO NOTHING
  RETURNING id INTO v_item_id;

  IF v_item_id IS NULL THEN
    SELECT id INTO v_item_id FROM public.ingestion_items
    WHERE workspace_id = v_conn.workspace_id AND content_hash = p_content_hash;
    UPDATE public.ingestion_connections SET last_used_at = v_now WHERE id = v_conn.id;
    RETURN jsonb_build_object('replayed', true, 'item_id', v_item_id);
  END IF;

  INSERT INTO public.sources (
    workspace_id, client_id, source_type, external_provider, external_id,
    title, content_text, occurred_at, metadata, content_hash, created_by
  ) VALUES (
    v_conn.workspace_id, v_conn.default_client_id, 'meeting', 'macwhisper', NULL,
    v_title, p_transcript, v_now, coalesce(p_metadata, '{}'::jsonb), p_content_hash, NULL
  ) RETURNING id INTO v_source_id;

  UPDATE public.ingestion_items SET source_id = v_source_id WHERE id = v_item_id;
  UPDATE public.ingestion_connections SET last_used_at = v_now WHERE id = v_conn.id;

  -- Audit records the fact, never the transcript, the secret or the URL.
  PERFORM public.audit_write_internal(
    v_conn.workspace_id, 'integration', NULL, v_conn.name,
    jsonb_build_object(
      'eventType', 'ingestion_item.received',
      'entityType', 'ingestion_item',
      'entityId', v_item_id,
      'clientId', v_conn.default_client_id,
      'description', 'Transcripción recibida desde ' || v_conn.name,
      'inputSummary', left(v_title, 200),
      'metadata', jsonb_build_object(
        'provider', 'macwhisper',
        'characters', length(p_transcript),
        'connectionId', v_conn.id
      )
    ),
    p_correlation_id
  );

  RETURN jsonb_build_object('replayed', false, 'item_id', v_item_id, 'source_id', v_source_id);
END $$;

REVOKE ALL ON FUNCTION public.receive_macwhisper_transcript_v1(uuid, text, text, text, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_macwhisper_transcript_v1(uuid, text, text, text, text, jsonb, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_macwhisper_transcript_v1(uuid, text, text, text, text, jsonb, uuid) TO service_role;

-- ============================================================
-- Atomic processing lock
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ingestion_item_v1(
  p_workspace_id uuid,
  p_item_id uuid,
  p_client_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_item public.ingestion_items;
  v_client uuid;
BEGIN
  PERFORM public.assert_workspace_access(p_workspace_id);

  SELECT * INTO v_item FROM public.ingestion_items
  WHERE workspace_id = p_workspace_id AND id = p_item_id
  FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF v_item.status = 'discarded' THEN RAISE EXCEPTION 'item_discarded'; END IF;
  IF v_item.status = 'processing' THEN RAISE EXCEPTION 'item_already_processing'; END IF;
  IF v_item.source_id IS NULL THEN RAISE EXCEPTION 'item_without_evidence'; END IF;

  v_client := coalesce(p_client_id, v_item.client_id);
  IF v_client IS NULL THEN RAISE EXCEPTION 'client_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients
                 WHERE workspace_id = p_workspace_id AND id = v_client) THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;

  UPDATE public.ingestion_items SET
    status = 'processing',
    client_id = v_client,
    error_message = NULL,
    error_code = NULL,
    processing_started_at = now()
  WHERE id = v_item.id;

  RETURN jsonb_build_object(
    'item_id', v_item.id,
    'source_id', v_item.source_id,
    'client_id', v_client,
    'title', v_item.title,
    'occurred_at', v_item.occurred_at,
    'previous_status', v_item.status
  );
END $$;

REVOKE ALL ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) TO authenticated, service_role;