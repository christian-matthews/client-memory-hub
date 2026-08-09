-- Real database integration suite (no mocks).
--
-- Runs entirely inside ONE transaction that is ROLLED BACK at the end, so it
-- can be executed against any environment without leaving residue:
--
--   psql -v ON_ERROR_STOP=1 -f scripts/db-integration.sql
--
-- Every check either prints "ok: ..." or aborts the script.

\set ON_ERROR_STOP on
BEGIN;

\echo '== setup =========================================================='
DO $$
DECLARE
  ws_a uuid; ws_b uuid;
  u_a uuid := gen_random_uuid();      -- owner of A
  u_admin uuid := gen_random_uuid();  -- admin of A
  u_b uuid := gen_random_uuid();      -- owner of B
  c_a uuid; c_b uuid; t_a uuid; s_b uuid; i_ro uuid; i_rw uuid; i_rev uuid; i_exp uuid;
BEGIN
  INSERT INTO workspaces (name, slug) VALUES ('WS A','it-a-'||substr(gen_random_uuid()::text,1,8)) RETURNING id INTO ws_a;
  INSERT INTO workspaces (name, slug) VALUES ('WS B','it-b-'||substr(gen_random_uuid()::text,1,8)) RETURNING id INTO ws_b;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    (ws_a, u_a, 'owner'), (ws_a, u_admin, 'admin'), (ws_b, u_b, 'owner');

  INSERT INTO clients (workspace_id, name) VALUES (ws_a,'Cliente A') RETURNING id INTO c_a;
  INSERT INTO clients (workspace_id, name) VALUES (ws_b,'Cliente B') RETURNING id INTO c_b;
  INSERT INTO topics (workspace_id, client_id, title, current_state) VALUES (ws_a,c_a,'Tema A','') RETURNING id INTO t_a;
  INSERT INTO sources (workspace_id, client_id, source_type, title) VALUES (ws_b,c_b,'manual_note','Fuente B') RETURNING id INTO s_b;

  INSERT INTO mcp_integrations (workspace_id, name, scopes, write_enabled, token_hash, token_prefix)
    VALUES (ws_a,'ro', ARRAY['read'], false, 'h_ro','cm_ro') RETURNING id INTO i_ro;
  INSERT INTO mcp_integrations (workspace_id, name, scopes, write_enabled, token_hash, token_prefix)
    VALUES (ws_a,'rw', ARRAY['read','write'], true, 'h_rw','cm_rw') RETURNING id INTO i_rw;
  INSERT INTO mcp_integrations (workspace_id, name, scopes, write_enabled, token_hash, token_prefix, revoked_at)
    VALUES (ws_a,'rev', ARRAY['read','write'], true, 'h_rev','cm_rev', now()) RETURNING id INTO i_rev;
  INSERT INTO mcp_integrations (workspace_id, name, scopes, write_enabled, token_hash, token_prefix, expires_at)
    VALUES (ws_a,'exp', ARRAY['read','write'], true, 'h_exp','cm_exp', now() - interval '1 day') RETURNING id INTO i_exp;

  CREATE TEMP TABLE fixture(k text primary key, v text) ON COMMIT DROP;
  INSERT INTO fixture VALUES
    ('ws_a',ws_a::text),('ws_b',ws_b::text),('u_a',u_a::text),('u_admin',u_admin::text),
    ('u_b',u_b::text),('c_a',c_a::text),('c_b',c_b::text),('t_a',t_a::text),('s_b',s_b::text),
    ('i_ro',i_ro::text),('i_rw',i_rw::text),('i_rev',i_rev::text),('i_exp',i_exp::text);
  RAISE NOTICE 'ok: fixture creada';
END $$;

-- Helper: run SQL as a signed-in user (RLS + auth.uid()).
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',p_user,'role','authenticated')::text, true);
  EXECUTE p_sql;
  PERFORM set_config('request.jwt.claims','',true);
  PERFORM set_config('role','postgres',true);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.must_fail(p_user text, p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM pg_temp.as_user(p_user, p_sql);
    RAISE EXCEPTION 'FALLA: % debió ser rechazado', p_label;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok (rechazado): % -> %', p_label, SQLERRM;
  WHEN others THEN
    RAISE NOTICE 'ok (rechazado): % -> %', p_label, SQLERRM;
  END;
  PERFORM set_config('request.jwt.claims','',true);
  PERFORM set_config('role','postgres',true);
END $$;

\echo '== P1: auditoria no falsificable ================================='
DO $$
DECLARE f record; n int;
BEGIN
  SELECT (SELECT v FROM fixture WHERE k='ws_a') ws_a,
         (SELECT v FROM fixture WHERE k='ws_b') ws_b,
         (SELECT v FROM fixture WHERE k='u_a') u_a,
         (SELECT v FROM fixture WHERE k='u_b') u_b INTO f;

  -- INSERT directo desde el navegador
  PERFORM pg_temp.must_fail(f.u_a,
    format('INSERT INTO activity_events (workspace_id, actor_type, event_type, entity_type, description) VALUES (%L,''user'',''x'',''y'',''z'')', f.ws_a),
    'insert directo en activity_events');

  -- Evento como IA / integración: el tipo pedido se ignora y se fuerza 'user'
  PERFORM pg_temp.as_user(f.u_a,
    format('SELECT record_activity_v1(%L, ''{"eventType":"spoof_ai","entityType":"y","description":"z"}''::jsonb, ''ai'')', f.ws_a));
  PERFORM pg_temp.as_user(f.u_a,
    format('SELECT record_activity_v1(%L, ''{"eventType":"spoof_int","entityType":"y","description":"z"}''::jsonb, ''integration'')', f.ws_a));
  SELECT count(*) INTO n FROM activity_events
   WHERE workspace_id=f.ws_a::uuid AND event_type IN ('spoof_ai','spoof_int') AND actor_type='user' AND actor_user_id=f.u_a::uuid;
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA: un usuario logró registrar eventos como IA/integración'; END IF;
  IF EXISTS (SELECT 1 FROM activity_events WHERE workspace_id=f.ws_a::uuid AND actor_type IN ('ai','integration') AND event_type LIKE 'spoof%') THEN
    RAISE EXCEPTION 'FALLA: actor_type falsificado persistido';
  END IF;
  RAISE NOTICE 'ok: actor_type solicitado por el navegador se ignora y se fuerza user';

  -- Otro workspace
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT record_activity_v1(%L, ''{"eventType":"x","entityType":"y","description":"z"}''::jsonb)', f.ws_b),
    'registrar evento en otro workspace');

  -- Atribución a otro usuario: se ignora, queda auth.uid()
  PERFORM pg_temp.as_user(f.u_a, format(
    'SELECT record_activity_v1(%L, jsonb_build_object(''eventType'',''t'',''entityType'',''e'',''description'',''d'',''actorUserId'',%L))',
    f.ws_a, f.u_b));
  SELECT count(*) INTO n FROM activity_events
   WHERE workspace_id = f.ws_a::uuid AND event_type='t' AND actor_user_id = f.u_a::uuid AND actor_type='user';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA: actor no derivado de auth.uid()'; END IF;
  RAISE NOTICE 'ok: actor_user_id derivado de auth.uid(), atribución ajena ignorada';

  -- Auditoría inmutable
  PERFORM pg_temp.must_fail(f.u_a,
    format('UPDATE activity_events SET description=''hack'' WHERE workspace_id=%L', f.ws_a),
    'update de auditoría');
END $$;

\echo '== P1/P5: aislamiento entre workspaces ==========================='
DO $$
DECLARE f record; n int;
BEGIN
  SELECT (SELECT v FROM fixture WHERE k='ws_a') ws_a, (SELECT v FROM fixture WHERE k='ws_b') ws_b,
         (SELECT v FROM fixture WHERE k='u_a') u_a, (SELECT v FROM fixture WHERE k='c_b') c_b,
         (SELECT v FROM fixture WHERE k='s_b') s_b, (SELECT v FROM fixture WHERE k='t_a') t_a INTO f;

  PERFORM pg_temp.as_user(f.u_a, format('CREATE TEMP TABLE probe AS SELECT count(*) c FROM clients WHERE workspace_id=%L', f.ws_b));
  SELECT c INTO n FROM probe; DROP TABLE probe;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA: A leyó clientes de B'; END IF;
  RAISE NOTICE 'ok: A no lee clientes de B (RLS)';

  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT domain_write(%L,''create_topic'',jsonb_build_object(''clientId'',%L,''title'',''x''))', f.ws_a, f.c_b),
    'tema apuntando a cliente de B');
  PERFORM pg_temp.must_fail(f.u_a,
    format('INSERT INTO topic_sources (workspace_id, topic_id, source_id) VALUES (%L,%L,%L)', f.ws_a, f.t_a, f.s_b),
    'vincular fuente de B');
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT domain_write(%L,''create_client'',''{"name":"intruso"}''::jsonb)', f.ws_b),
    'escribir en workspace ajeno');
END $$;

\echo '== P2/P3: idempotencia atomica y aislamiento de claves ==========='
DO $$
DECLARE f record; r1 jsonb; r2 jsonb; n int;
BEGIN
  SELECT (SELECT v FROM fixture WHERE k='ws_a') ws_a, (SELECT v FROM fixture WHERE k='u_a') u_a,
         (SELECT v FROM fixture WHERE k='u_admin') u_admin, (SELECT v FROM fixture WHERE k='t_a') t_a INTO f;

  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',f.u_a,'role','authenticated')::text, true);

  r1 := domain_write(f.ws_a::uuid,'create_client','{"name":"Idem SA"}'::jsonb,'hash1','k-1');
  r2 := domain_write(f.ws_a::uuid,'create_client','{"name":"Idem SA"}'::jsonb,'hash1','k-1');
  IF r1->>'clientId' <> r2->>'clientId' THEN RAISE EXCEPTION 'FALLA: replay creó otra entidad'; END IF;
  IF (r2->>'replayed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: replay no marcado'; END IF;
  SELECT count(*) INTO n FROM clients WHERE workspace_id=f.ws_a::uuid AND name='Idem SA';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA: efecto duplicado (%)', n; END IF;
  RAISE NOTICE 'ok: misma clave + mismo payload => resultado original, un solo efecto';

  PERFORM set_config('request.jwt.claims','',true);
  PERFORM set_config('role','postgres',true);

  -- mismo key, payload distinto
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT domain_write(%L,''create_client'',''{"name":"Otra"}''::jsonb,''hash2'',''k-1'')', f.ws_a),
    'misma clave con payload distinto');
  -- misma clave, otra operación
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT domain_write(%L,''create_topic'',''{"title":"x"}''::jsonb,''hash1'',''k-1'')', f.ws_a),
    'misma clave para otra operación');
  -- otro usuario del mismo workspace no puede tocar la clave ajena
  PERFORM pg_temp.must_fail(f.u_admin,
    format('SELECT domain_write(%L,''create_client'',''{"name":"Idem SA"}''::jsonb,''hash1'',''k-1'')', f.ws_a),
    'clave de otro usuario');
  -- RPCs internas de idempotencia no son ejecutables
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT idempotency_reserve(%L,''k-1'',''create_client'',''hash1'')', f.ws_a),
    'idempotency_reserve directo');
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT idempotency_finish(%L,''k-1'',true,''{}''::jsonb)', f.ws_a),
    'idempotency_finish directo');
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT add_topic_update_tx(%L,%L,''hack'')', f.ws_a, f.t_a),
    'add_topic_update_tx directo (falsificar actor)');
END $$;

\echo '== P2: operacion compuesta y rollback ============================'
DO $$
DECLARE f record; before_updates int; before_events int; r jsonb;
BEGIN
  SELECT (SELECT v FROM fixture WHERE k='ws_a') ws_a, (SELECT v FROM fixture WHERE k='u_a') u_a,
         (SELECT v FROM fixture WHERE k='t_a') t_a INTO f;

  SELECT count(*) INTO before_updates FROM topic_updates WHERE workspace_id=f.ws_a::uuid;
  SELECT count(*) INTO before_events FROM activity_events WHERE workspace_id=f.ws_a::uuid;

  BEGIN
    PERFORM pg_temp.as_user(f.u_a, format(
      'SELECT domain_write(%L,''add_topic_update'',jsonb_build_object(''topicId'',%L,''content'',''avance'',''commitment'',jsonb_build_object(''description'',''x'',''responsibleParty'',''invalido'')),''h'',''k-tx'')',
      f.ws_a, f.t_a));
    RAISE EXCEPTION 'FALLA: compromiso inválido debió abortar';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok (abortado): operación compuesta inválida -> %', SQLERRM;
  END;
  PERFORM set_config('request.jwt.claims','',true);
  PERFORM set_config('role','postgres',true);

  IF (SELECT count(*) FROM topic_updates WHERE workspace_id=f.ws_a::uuid) <> before_updates
     OR (SELECT count(*) FROM activity_events WHERE workspace_id=f.ws_a::uuid) <> before_events
     OR EXISTS (SELECT 1 FROM idempotency_keys WHERE workspace_id=f.ws_a::uuid AND key='k-tx') THEN
    RAISE EXCEPTION 'FALLA: la operación fallida dejó cambios';
  END IF;
  RAISE NOTICE 'ok: operación compuesta fallida no deja entidad, auditoría ni clave';

  -- éxito: entidad + auditoría en la misma transacción
  PERFORM pg_temp.as_user(f.u_a, format(
    'SELECT domain_write(%L,''add_topic_update'',jsonb_build_object(''topicId'',%L,''content'',''avance real'',''nextStep'',''llamar''),''h2'',''k-ok'')',
    f.ws_a, f.t_a));
  IF NOT EXISTS (SELECT 1 FROM topic_updates WHERE workspace_id=f.ws_a::uuid AND content='avance real')
     OR NOT EXISTS (SELECT 1 FROM activity_events WHERE workspace_id=f.ws_a::uuid AND event_type='topic.update_added')
     OR NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE workspace_id=f.ws_a::uuid AND key='k-ok' AND status='completed') THEN
    RAISE EXCEPTION 'FALLA: la operación compuesta no persistió todo';
  END IF;
  RAISE NOTICE 'ok: actualización + auditoría + clave completada en una transacción';
END $$;

\echo '== P5: triggers de membresia ====================================='
DO $$
DECLARE f record;
BEGIN
  SELECT (SELECT v FROM fixture WHERE k='ws_a') ws_a, (SELECT v FROM fixture WHERE k='u_a') u_a,
         (SELECT v FROM fixture WHERE k='u_admin') u_admin INTO f;

  PERFORM pg_temp.must_fail(f.u_admin,
    format('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (%L,%L,''owner'')', f.ws_a, gen_random_uuid()),
    'admin otorga owner');
  PERFORM pg_temp.must_fail(f.u_admin,
    format('DELETE FROM workspace_members WHERE workspace_id=%L AND user_id=%L', f.ws_a, f.u_a),
    'admin elimina owner');
  PERFORM pg_temp.must_fail(f.u_a,
    format('UPDATE workspace_members SET role=''member'' WHERE workspace_id=%L AND user_id=%L', f.ws_a, f.u_a),
    'degradar al último owner');
  PERFORM pg_temp.must_fail(f.u_a,
    format('DELETE FROM workspace_members WHERE workspace_id=%L AND user_id=%L', f.ws_a, f.u_a),
    'eliminar al último owner');
END $$;

\echo '== P4: foreign keys ON DELETE SET NULL ==========================='
DO $$
DECLARE ws uuid; c uuid; t uuid; s uuid; d uuid; ev uuid;
BEGIN
  INSERT INTO workspaces (name,slug) VALUES ('FK WS','it-fk-'||substr(gen_random_uuid()::text,1,8)) RETURNING id INTO ws;
  INSERT INTO clients (workspace_id,name) VALUES (ws,'FK C') RETURNING id INTO c;
  INSERT INTO topics (workspace_id,client_id,title,current_state) VALUES (ws,c,'FK T','') RETURNING id INTO t;
  INSERT INTO sources (workspace_id,client_id,source_type,title) VALUES (ws,c,'manual_note','FK S') RETURNING id INTO s;
  INSERT INTO decisions (workspace_id,client_id,topic_id,description,source_id) VALUES (ws,c,t,'FK D',s) RETURNING id INTO d;
  INSERT INTO activity_events (workspace_id,client_id,topic_id,actor_type,event_type,entity_type,description)
    VALUES (ws,c,t,'system','fk.test','topic','FK E') RETURNING id INTO ev;

  DELETE FROM sources WHERE id = s;
  IF NOT EXISTS (SELECT 1 FROM decisions WHERE id=d AND source_id IS NULL AND workspace_id=ws) THEN
    RAISE EXCEPTION 'FALLA: borrar fuente rompió la decisión o anuló workspace_id';
  END IF;
  RAISE NOTICE 'ok: borrar fuente anula solo source_id y conserva workspace_id';

  DELETE FROM topics WHERE id = t;
  IF NOT EXISTS (SELECT 1 FROM activity_events WHERE id=ev AND topic_id IS NULL AND workspace_id=ws) THEN
    RAISE EXCEPTION 'FALLA: borrar tema anuló workspace_id del evento';
  END IF;
  DELETE FROM clients WHERE id = c;
  IF NOT EXISTS (SELECT 1 FROM activity_events WHERE id=ev AND client_id IS NULL AND workspace_id=ws) THEN
    RAISE EXCEPTION 'FALLA: borrar cliente anuló workspace_id del evento';
  END IF;
  RAISE NOTICE 'ok: borrar tema/cliente anula solo la columna opcional';

  DELETE FROM workspaces WHERE id = ws;
  IF EXISTS (SELECT 1 FROM activity_events WHERE workspace_id=ws) THEN
    RAISE EXCEPTION 'FALLA: eliminar workspace dejó eventos huérfanos';
  END IF;
  RAISE NOTICE 'ok: eliminar workspace elimina en cascada sus registros';
END $$;

\echo '== P6/P7: credenciales MCP ======================================='
DO $$
DECLARE f record; r jsonb; n int;
BEGIN
  SELECT (SELECT v FROM fixture WHERE k='i_ro') i_ro, (SELECT v FROM fixture WHERE k='i_rw') i_rw,
         (SELECT v FROM fixture WHERE k='i_rev') i_rev, (SELECT v FROM fixture WHERE k='i_exp') i_exp,
         (SELECT v FROM fixture WHERE k='ws_a') ws_a, (SELECT v FROM fixture WHERE k='ws_b') ws_b,
         (SELECT v FROM fixture WHERE k='u_a') u_a INTO f;

  PERFORM set_config('role','service_role',true);

  BEGIN
    PERFORM domain_write_as_integration(f.i_ro::uuid,'create_client','{"name":"ro"}'::jsonb,'h','k-ro');
    RAISE EXCEPTION 'FALLA: integración read-only pudo escribir';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok (rechazado): integración read-only escribe -> %', SQLERRM;
  END;

  BEGIN
    PERFORM domain_write_as_integration(f.i_rev::uuid,'create_client','{"name":"rev"}'::jsonb,'h','k-rev');
    RAISE EXCEPTION 'FALLA: token revocado siguió funcionando';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok (rechazado): credencial revocada -> %', SQLERRM;
  END;

  BEGIN
    PERFORM domain_write_as_integration(f.i_exp::uuid,'create_client','{"name":"exp"}'::jsonb,'h','k-exp');
    RAISE EXCEPTION 'FALLA: token expirado siguió funcionando';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok (rechazado): credencial expirada -> %', SQLERRM;
  END;

  -- el workspace se deriva del token, nunca del payload
  r := domain_write_as_integration(f.i_rw::uuid,'create_client',
        jsonb_build_object('name','Desde MCP','workspaceId',f.ws_b),'h','k-mcp');
  SELECT count(*) INTO n FROM clients WHERE id=(r->>'clientId')::uuid AND workspace_id=f.ws_a::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA: el workspace no vino del token'; END IF;
  IF NOT EXISTS (SELECT 1 FROM activity_events WHERE workspace_id=f.ws_a::uuid
                 AND entity_id=(r->>'clientId')::uuid AND actor_type='integration' AND actor_user_id IS NULL) THEN
    RAISE EXCEPTION 'FALLA: auditoría de integración incorrecta';
  END IF;
  RAISE NOTICE 'ok: escritura MCP usa el workspace del token y audita como integración';

  -- una integración no puede tocar la clave de otra
  BEGIN
    PERFORM domain_write_as_integration(f.i_rw::uuid,'create_client','{"name":"Desde MCP"}'::jsonb,'h','k-mcp');
    RAISE EXCEPTION 'FALLA: hash distinto aceptado';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok (rechazado): misma clave, payload distinto (MCP) -> %', SQLERRM;
  END;

  PERFORM set_config('role','postgres',true);

  -- un usuario autenticado no puede usar la ruta privilegiada
  PERFORM pg_temp.must_fail(f.u_a,
    format('SELECT domain_write_as_integration(%L,''create_client'',''{"name":"x"}''::jsonb)', f.i_rw),
    'usuario usando la ruta de integración');
END $$;

\echo '== fin: rollback ================================================='
ROLLBACK;
