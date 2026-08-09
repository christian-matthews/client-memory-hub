-- 1) claim_ingestion_item_v1: privileged server only.
REVOKE ALL ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_item_v1(uuid, uuid, uuid) TO service_role;

-- 2) source_derivatives are internal, versioned AI outputs: read-only for members.
DROP POLICY IF EXISTS source_derivatives_insert_members ON public.source_derivatives;
REVOKE INSERT, UPDATE, DELETE ON public.source_derivatives FROM authenticated;
GRANT SELECT ON public.source_derivatives TO authenticated;
GRANT ALL ON public.source_derivatives TO service_role;

-- 3) Atomic success commit: proposals + derivative + run + item in ONE transaction.
CREATE OR REPLACE FUNCTION public.finish_meeting_extraction_v1(
  p_workspace_id uuid,
  p_item_id uuid,
  p_ai_run_id uuid,
  p_source_id uuid,
  p_client_id uuid,
  p_language text,
  p_summary_text text,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_derivative_metadata jsonb DEFAULT '{}'::jsonb,
  p_structured_output jsonb DEFAULT '{}'::jsonb,
  p_proposals jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_count integer := 0;
  v_status public.ingestion_status;
  v_derivative uuid;
BEGIN
  IF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_actor';
  END IF;
  IF jsonb_typeof(coalesce(p_proposals, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'bad_request';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ingestion_items
                 WHERE workspace_id = p_workspace_id AND id = p_item_id
                   AND status = 'processing') THEN
    RAISE EXCEPTION 'item_not_processing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_runs
                 WHERE workspace_id = p_workspace_id AND id = p_ai_run_id
                   AND status = 'running') THEN
    RAISE EXCEPTION 'run_not_running';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sources
                 WHERE workspace_id = p_workspace_id AND id = p_source_id) THEN
    RAISE EXCEPTION 'source_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients
                 WHERE workspace_id = p_workspace_id AND id = p_client_id) THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;

  INSERT INTO public.ai_proposals (
    workspace_id, ai_run_id, client_id, topic_id, proposal_type,
    proposed_changes, explanation, confidence, evidence, status
  )
  SELECT
    p_workspace_id,
    p_ai_run_id,
    p_client_id,
    nullif(p->>'topic_id','')::uuid,
    p->>'proposal_type',
    coalesce(p->'proposed_changes', '{}'::jsonb),
    coalesce(p->>'explanation',''),
    nullif(p->>'confidence','')::numeric,
    coalesce(p->'evidence', '{}'::jsonb),
    'pending'
  FROM jsonb_array_elements(coalesce(p_proposals,'[]'::jsonb)) AS p;
  v_count := coalesce((SELECT count(*)::int FROM jsonb_array_elements(coalesce(p_proposals,'[]'::jsonb))), 0);

  INSERT INTO public.source_derivatives (
    workspace_id, source_id, ai_run_id, derivative_type, content_text,
    language, prompt_version, provider, model, metadata
  ) VALUES (
    p_workspace_id, p_source_id, p_ai_run_id, 'meeting_summary', p_summary_text,
    nullif(p_language,''), p_prompt_version, p_provider, p_model,
    coalesce(p_derivative_metadata,'{}'::jsonb)
  ) RETURNING id INTO v_derivative;

  UPDATE public.ai_runs SET
    status = 'completed',
    structured_output = coalesce(p_structured_output,'{}'::jsonb),
    error_message = NULL,
    completed_at = now()
  WHERE workspace_id = p_workspace_id AND id = p_ai_run_id;

  v_status := CASE WHEN v_count > 0 THEN 'needs_review'::public.ingestion_status
                   ELSE 'processed'::public.ingestion_status END;

  UPDATE public.ingestion_items SET
    status = v_status,
    client_id = p_client_id,
    ai_run_id = p_ai_run_id,
    language = nullif(p_language,''),
    proposal_count = v_count,
    processed_at = now(),
    error_message = NULL,
    error_code = NULL
  WHERE workspace_id = p_workspace_id AND id = p_item_id;

  RETURN jsonb_build_object(
    'proposal_count', v_count,
    'status', v_status,
    'derivative_id', v_derivative
  );
END $$;

REVOKE ALL ON FUNCTION public.finish_meeting_extraction_v1(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_meeting_extraction_v1(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finish_meeting_extraction_v1(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finish_meeting_extraction_v1(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb) TO service_role;

-- 4) Controlled failure: never leave an item stuck in `processing`.
CREATE OR REPLACE FUNCTION public.fail_meeting_extraction_v1(
  p_workspace_id uuid,
  p_item_id uuid,
  p_ai_run_id uuid,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF current_setting('role', true) NOT IN ('service_role') AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden_actor';
  END IF;

  IF p_ai_run_id IS NOT NULL THEN
    UPDATE public.ai_runs SET
      status = 'failed',
      error_message = left(coalesce(p_error_code,'ai_run_failed'), 80),
      completed_at = now()
    WHERE workspace_id = p_workspace_id AND id = p_ai_run_id AND status = 'running';

    DELETE FROM public.ai_proposals
    WHERE workspace_id = p_workspace_id AND ai_run_id = p_ai_run_id AND status = 'pending';
  END IF;

  UPDATE public.ingestion_items SET
    status = 'failed',
    ai_run_id = coalesce(p_ai_run_id, ai_run_id),
    error_code = left(coalesce(p_error_code,'ai_run_failed'), 80),
    error_message = NULL,
    processed_at = NULL
  WHERE workspace_id = p_workspace_id AND id = p_item_id AND status = 'processing';

  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.fail_meeting_extraction_v1(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_meeting_extraction_v1(uuid, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fail_meeting_extraction_v1(uuid, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_meeting_extraction_v1(uuid, uuid, uuid, text) TO service_role;