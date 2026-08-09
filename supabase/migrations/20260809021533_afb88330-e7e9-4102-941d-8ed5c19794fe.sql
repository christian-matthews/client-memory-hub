REVOKE ALL ON FUNCTION public.domain_write(uuid, text, jsonb, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_activity_v1(uuid, jsonb, public.actor_type, text, uuid) FROM anon;

CREATE OR REPLACE FUNCTION public.add_topic_update_tx(p_workspace_id uuid, p_topic_id uuid, p_content text, p_update_type update_type DEFAULT 'note'::update_type, p_is_relevant boolean DEFAULT true, p_status topic_status DEFAULT NULL::topic_status, p_ball_with party DEFAULT NULL::party, p_current_state text DEFAULT NULL::text, p_next_step_set boolean DEFAULT false, p_next_step text DEFAULT NULL::text, p_next_step_owner party DEFAULT 'nobody'::party, p_next_step_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_decision text DEFAULT NULL::text, p_commitment jsonb DEFAULT NULL::jsonb, p_source_id uuid DEFAULT NULL::uuid, p_actor_type actor_type DEFAULT 'user'::actor_type, p_actor_user_id uuid DEFAULT NULL::uuid, p_actor_name text DEFAULT NULL::text, p_actor_channel text DEFAULT NULL::text, p_correlation_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_request_hash text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_topic public.topics;
  v_update_id uuid;
  v_effects text[] := ARRAY[]::text[];
  v_now timestamptz := now();
  v_existing public.idempotency_keys;
  v_result jsonb;
  v_decision_id uuid;
  v_commitment_id uuid;
BEGIN
  PERFORM public.assert_workspace_access(p_workspace_id);

  IF p_content IS NULL OR length(btrim(p_content)) = 0 THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.idempotency_keys (workspace_id, key, operation, actor_type, request_hash)
    VALUES (p_workspace_id, p_idempotency_key, 'add_topic_update', p_actor_type, coalesce(p_request_hash, ''))
    ON CONFLICT (workspace_id, key) DO NOTHING;

    IF NOT FOUND THEN
      SELECT * INTO v_existing FROM public.idempotency_keys
      WHERE workspace_id = p_workspace_id AND key = p_idempotency_key FOR UPDATE;

      IF v_existing.request_hash <> coalesce(p_request_hash, '') THEN
        RAISE EXCEPTION 'idempotency_conflict';
      END IF;
      IF v_existing.status = 'completed' THEN
        RETURN v_existing.result;
      END IF;
      UPDATE public.idempotency_keys
      SET status = 'in_progress', error_message = NULL, created_at = v_now
      WHERE workspace_id = p_workspace_id AND key = p_idempotency_key;
    END IF;
  END IF;

  SELECT * INTO v_topic FROM public.topics
  WHERE workspace_id = p_workspace_id AND id = p_topic_id;
  IF v_topic.id IS NULL THEN
    RAISE EXCEPTION 'topic_not_found';
  END IF;

  INSERT INTO public.topic_updates
    (workspace_id, client_id, topic_id, update_type, content, is_relevant, created_by)
  VALUES
    (p_workspace_id, v_topic.client_id, v_topic.id, p_update_type, p_content, p_is_relevant, p_actor_user_id)
  RETURNING id INTO v_update_id;
  v_effects := array_append(v_effects, 'actualización registrada');

  UPDATE public.topics SET
    status = COALESCE(p_status, status),
    resolved_at = CASE WHEN p_status = 'resolved' THEN v_now ELSE resolved_at END,
    archived_at = CASE WHEN p_status = 'archived' THEN v_now ELSE archived_at END,
    ball_with = COALESCE(p_ball_with, ball_with),
    current_state = COALESCE(p_current_state, current_state),
    next_step = CASE WHEN p_next_step_set THEN p_next_step ELSE next_step END,
    next_step_owner = CASE WHEN p_next_step_set THEN COALESCE(p_next_step_owner,'nobody') ELSE next_step_owner END,
    next_step_due_at = CASE WHEN p_next_step_set THEN p_next_step_due_at ELSE next_step_due_at END,
    last_relevant_change_at = CASE WHEN p_is_relevant THEN v_now ELSE last_relevant_change_at END
  WHERE workspace_id = p_workspace_id AND id = p_topic_id;

  IF p_status IS NOT NULL AND p_status <> v_topic.status THEN
    v_effects := array_append(v_effects, 'estado → ' || p_status::text);
  END IF;
  IF p_ball_with IS NOT NULL AND p_ball_with <> v_topic.ball_with THEN
    v_effects := array_append(v_effects, 'pelota → ' || p_ball_with::text);
  END IF;
  IF p_current_state IS NOT NULL THEN
    v_effects := array_append(v_effects, 'estado actual actualizado');
  END IF;
  IF p_next_step_set THEN
    v_effects := array_append(v_effects, 'próximo paso actualizado');
  END IF;

  IF p_decision IS NOT NULL AND length(btrim(p_decision)) > 0 THEN
    INSERT INTO public.decisions
      (workspace_id, client_id, topic_id, description, source_id, created_by)
    VALUES
      (p_workspace_id, v_topic.client_id, v_topic.id, p_decision, p_source_id, p_actor_user_id)
    RETURNING id INTO v_decision_id;
    v_effects := array_append(v_effects, 'decisión registrada');
  END IF;

  IF p_commitment IS NOT NULL AND p_commitment ? 'description' THEN
    INSERT INTO public.commitments
      (workspace_id, client_id, topic_id, description, responsible_party, responsible_name, due_at)
    VALUES (
      p_workspace_id, v_topic.client_id, v_topic.id,
      p_commitment->>'description',
      (p_commitment->>'responsibleParty')::public.responsible_party,
      NULLIF(p_commitment->>'responsibleName',''),
      NULLIF(p_commitment->>'dueAt','')::timestamptz
    ) RETURNING id INTO v_commitment_id;
    v_effects := array_append(v_effects, 'compromiso creado');
  END IF;

  IF p_source_id IS NOT NULL THEN
    INSERT INTO public.topic_sources (workspace_id, topic_id, source_id, linked_by)
    VALUES (p_workspace_id, v_topic.id, p_source_id, p_actor_user_id)
    ON CONFLICT (topic_id, source_id) DO NOTHING;
    v_effects := array_append(v_effects, 'fuente vinculada');
  END IF;

  IF p_is_relevant THEN
    UPDATE public.clients SET last_relevant_activity_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_topic.client_id;
  END IF;

  INSERT INTO public.activity_events (
    workspace_id, client_id, topic_id, actor_type, actor_user_id, actor_name,
    event_type, entity_type, entity_id, description, input_summary, metadata,
    correlation_id, idempotency_key
  ) VALUES (
    p_workspace_id, v_topic.client_id, v_topic.id, p_actor_type, p_actor_user_id, p_actor_name,
    'topic.update_added', 'topic_update', v_update_id,
    'Actualización en “' || v_topic.title || '”: ' || array_to_string(v_effects, ', '),
    left(p_content, 200),
    jsonb_build_object('effects', to_jsonb(v_effects), 'channel', p_actor_channel),
    COALESCE(p_correlation_id, gen_random_uuid()), p_idempotency_key
  );

  v_result := jsonb_build_object(
    'updateId', v_update_id,
    'topicId', v_topic.id,
    'clientId', v_topic.client_id,
    'decisionId', v_decision_id,
    'commitmentId', v_commitment_id,
    'effects', to_jsonb(v_effects),
    'replayed', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.idempotency_keys
    SET status = 'completed', result = jsonb_set(v_result, '{replayed}', 'true'::jsonb), completed_at = v_now
    WHERE workspace_id = p_workspace_id AND key = p_idempotency_key;
  END IF;

  RETURN v_result;
END $function$;

REVOKE ALL ON FUNCTION public.add_topic_update_tx(
  uuid, uuid, text, public.update_type, boolean, public.topic_status, public.party, text,
  boolean, text, public.party, timestamptz, text, jsonb, uuid, public.actor_type, uuid, text,
  text, uuid, text, text) FROM PUBLIC, anon, authenticated;