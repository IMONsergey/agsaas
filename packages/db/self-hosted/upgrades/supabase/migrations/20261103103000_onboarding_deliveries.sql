-- Registration delivery belongs to the local database and worker. Existing
-- users are not bulk mailed when this migration is installed.
CREATE TABLE IF NOT EXISTS private.onboarding_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO private.onboarding_installation(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS private.onboarding_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('welcome','activation')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','canceled','rejected','reconciliation')),
  due_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  recipient text,context_hash text,envelope text,envelope_hash text,
  lease_token uuid,lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  first_attempt_at timestamptz,accepted_at timestamptz,provider_message_id text,
  last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,kind),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK (envelope IS NULL OR octet_length(envelope)<=524288),
  CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 256)
);
CREATE INDEX IF NOT EXISTS onboarding_deliveries_due ON private.onboarding_deliveries(next_attempt_at,id) WHERE status IN ('pending','sending');
REVOKE ALL ON private.onboarding_installation,private.onboarding_deliveries FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.enqueue_onboarding(p_user uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_created timestamptz;
BEGIN
  SELECT created_at INTO v_created FROM public.users WHERE id=p_user AND deletion_started_at IS NULL;
  IF NOT FOUND OR v_created<(SELECT enabled_at FROM private.onboarding_installation WHERE singleton) THEN RETURN false; END IF;
  INSERT INTO private.onboarding_deliveries(user_id,kind,due_at,next_attempt_at)
    VALUES(p_user,'welcome',v_created+interval '10 minutes',v_created+interval '10 minutes'),
      (p_user,'activation',v_created+interval '3 days',v_created+interval '3 days') ON CONFLICT(user_id,kind) DO NOTHING;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION private.onboarding_profile_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM private.enqueue_onboarding(NEW.id); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS agsaas_onboarding_profile_created ON public.users;
CREATE TRIGGER agsaas_onboarding_profile_created AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION private.onboarding_profile_created();

CREATE OR REPLACE FUNCTION private.onboarding_context(p_user uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u public.users%ROWTYPE; a auth.users%ROWTYPE; v_team uuid; v_name text; v_hash text;
BEGIN
  SELECT * INTO u FROM public.users WHERE id=p_user;
  SELECT * INTO a FROM auth.users WHERE id=p_user;
  IF u.id IS NULL OR a.id IS NULL OR u.deletion_started_at IS NOT NULL OR a.deleted_at IS NOT NULL OR a.banned_until>now() THEN
    RETURN jsonb_build_object('eligible',false,'reason','user_unavailable');
  END IF;
  IF nullif(a.email,'') IS NULL OR a.email_confirmed_at IS NULL OR a.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN jsonb_build_object('eligible',false,'reason','email_unverified');
  END IF;
  IF p_kind NOT IN ('welcome','activation') THEN RAISE EXCEPTION 'Invalid onboarding kind' USING ERRCODE='22023'; END IF;
  SELECT t.id INTO v_team FROM public.teams t JOIN public.users_on_team m ON m.team_id=t.id AND m.user_id=p_user WHERE t.id=u.team_id;
  -- An explicit opt-out in any current team suppresses the personal welcome.
  IF p_kind='welcome' AND EXISTS(SELECT 1 FROM public.notification_settings s JOIN public.users_on_team m ON m.team_id=s.team_id AND m.user_id=s.user_id
    WHERE s.user_id=p_user AND s.channel='email' AND s.notification_type='onboarding_welcome' AND NOT s.enabled) THEN
    RETURN jsonb_build_object('eligible',false,'reason','preference_disabled');
  END IF;
  IF p_kind='activation' THEN
    IF v_team IS NULL OR NOT EXISTS(SELECT 1 FROM public.teams WHERE id=v_team AND plan='trial' AND canceled_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.bank_connections WHERE team_id=v_team AND status='connected') THEN
      RETURN jsonb_build_object('eligible',false,'reason','activation_not_needed');
    END IF;
    -- Product tips require an actual saved opt-in. No marketing contact is
    -- created and absence of a preference never becomes implied consent.
    IF NOT EXISTS(SELECT 1 FROM public.notification_settings WHERE user_id=p_user AND team_id=v_team AND channel='email' AND notification_type='onboarding_tips' AND enabled) THEN
      RETURN jsonb_build_object('eligible',false,'reason','preference_disabled');
    END IF;
  END IF;
  v_name:=coalesce(nullif(left(btrim(u.full_name),200),''),'there');
  v_hash:=encode(sha256(convert_to(jsonb_build_array(p_user,p_kind,a.email,v_name,v_team)::text,'UTF8')),'hex');
  RETURN jsonb_build_object('eligible',true,'recipient',a.email,'fullName',v_name,'teamId',v_team,'hash',v_hash);
END $$;

CREATE OR REPLACE FUNCTION private.list_due_onboarding(p_limit integer DEFAULT 10)
RETURNS TABLE(id uuid,user_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user uuid;
BEGIN
  -- Reconcile a lost/disabled trigger without replaying historical users.
  FOR v_user IN SELECT u.id FROM public.users u WHERE u.created_at>=(SELECT enabled_at FROM private.onboarding_installation WHERE singleton)
    AND u.deletion_started_at IS NULL AND NOT EXISTS(SELECT 1 FROM private.onboarding_deliveries d WHERE d.user_id=u.id AND d.kind='welcome') ORDER BY u.created_at LIMIT 50
  LOOP PERFORM private.enqueue_onboarding(v_user); END LOOP;
  RETURN QUERY SELECT d.id,d.user_id FROM private.onboarding_deliveries d
    WHERE d.status IN ('pending','sending') AND d.due_at<=now() AND d.next_attempt_at<=now() AND (d.lease_until IS NULL OR d.lease_until<=now())
    ORDER BY d.next_attempt_at,d.id LIMIT least(greatest(p_limit,1),25);
END $$;

CREATE OR REPLACE FUNCTION private.get_onboarding_delivery(p_id uuid,p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',d.id,'userId',d.user_id,'kind',d.kind,'status',d.status,'recipient',d.recipient,
    'contextHash',d.context_hash,'envelope',d.envelope,'envelopeHash',d.envelope_hash,'firstAttemptAt',d.first_attempt_at,
    'context',private.onboarding_context(d.user_id,d.kind)) FROM private.onboarding_deliveries d WHERE d.id=p_id AND d.user_id=p_user
$$;

CREATE OR REPLACE FUNCTION private.prepare_onboarding_delivery(p_id uuid,p_user uuid,p_context_hash text,p_envelope text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d private.onboarding_deliveries%ROWTYPE; v_context jsonb; v_body jsonb;
BEGIN
  PERFORM 1 FROM auth.users WHERE id=p_user FOR SHARE;
  PERFORM 1 FROM public.users WHERE id=p_user FOR SHARE;
  SELECT * INTO d FROM private.onboarding_deliveries WHERE id=p_id AND user_id=p_user FOR UPDATE;
  IF NOT FOUND OR d.status<>'pending' OR d.first_attempt_at IS NOT NULL THEN RETURN false; END IF;
  v_context:=private.onboarding_context(p_user,d.kind);
  IF (v_context->>'eligible')::boolean IS DISTINCT FROM true OR v_context->>'hash' IS DISTINCT FROM p_context_hash THEN RETURN false; END IF;
  IF p_envelope IS NULL OR octet_length(p_envelope)>524288 THEN RAISE EXCEPTION 'Invalid onboarding envelope' USING ERRCODE='22023'; END IF;
  v_body:=p_envelope::jsonb;
  IF jsonb_typeof(v_body)<>'object' OR v_body->'to' IS DISTINCT FROM jsonb_build_array(v_context->>'recipient') OR v_body ? 'cc' OR v_body ? 'bcc'
    OR jsonb_typeof(v_body->'html') IS DISTINCT FROM 'string' OR jsonb_typeof(v_body->'from') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Invalid onboarding recipient' USING ERRCODE='22023';
  END IF;
  UPDATE private.onboarding_deliveries SET recipient=v_context->>'recipient',context_hash=p_context_hash,envelope=p_envelope,
    envelope_hash=encode(sha256(convert_to(p_envelope,'UTF8')),'hex'),last_error=NULL,updated_at=clock_timestamp() WHERE id=p_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION private.claim_onboarding_delivery(p_id uuid,p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d private.onboarding_deliveries%ROWTYPE; v_context jsonb; v_token uuid; v_reason text;
BEGIN
  PERFORM 1 FROM auth.users WHERE id=p_user FOR SHARE;
  PERFORM 1 FROM public.users WHERE id=p_user FOR SHARE;
  SELECT * INTO d FROM private.onboarding_deliveries WHERE id=p_id AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','canceled'); END IF;
  IF d.status NOT IN ('pending','sending') THEN RETURN jsonb_build_object('state',d.status); END IF;
  IF d.status='sending' THEN
    IF d.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('state','busy'); END IF;
    UPDATE private.onboarding_deliveries SET status='reconciliation',last_error='delivery_outcome_unknown',updated_at=clock_timestamp() WHERE id=p_id;
    RETURN jsonb_build_object('state','reconciliation');
  END IF;
  IF d.due_at>clock_timestamp() OR d.next_attempt_at>clock_timestamp() THEN RETURN jsonb_build_object('state','busy'); END IF;
  v_context:=private.onboarding_context(p_user,d.kind);
  IF (v_context->>'eligible')::boolean IS DISTINCT FROM true THEN
    v_reason:=v_context->>'reason';
    IF v_reason='email_unverified' AND d.created_at>now()-interval '7 days' THEN
      UPDATE private.onboarding_deliveries SET next_attempt_at=clock_timestamp()+interval '1 hour',last_error=v_reason,updated_at=clock_timestamp() WHERE id=p_id;
      RETURN jsonb_build_object('state','busy');
    END IF;
    UPDATE private.onboarding_deliveries SET status='canceled',last_error=v_reason,envelope=NULL,recipient=NULL,updated_at=clock_timestamp() WHERE id=p_id;
    RETURN jsonb_build_object('state','canceled');
  END IF;
  IF d.context_hash IS DISTINCT FROM v_context->>'hash' THEN
    IF d.first_attempt_at IS NOT NULL THEN
      UPDATE private.onboarding_deliveries SET status='reconciliation',last_error='identity_changed_after_attempt',updated_at=clock_timestamp() WHERE id=p_id;
      RETURN jsonb_build_object('state','reconciliation');
    END IF;
    UPDATE private.onboarding_deliveries SET recipient=NULL,context_hash=NULL,envelope=NULL,envelope_hash=NULL,updated_at=clock_timestamp() WHERE id=p_id;
    RETURN jsonb_build_object('state','unprepared');
  END IF;
  IF d.envelope IS NULL THEN RETURN jsonb_build_object('state','unprepared'); END IF;
  IF d.envelope_hash IS DISTINCT FROM encode(sha256(convert_to(d.envelope,'UTF8')),'hex') OR d.attempts>=8 THEN
    UPDATE private.onboarding_deliveries SET status='reconciliation',last_error='envelope_or_attempt_fence',updated_at=clock_timestamp() WHERE id=p_id;
    RETURN jsonb_build_object('state','reconciliation');
  END IF;
  v_token:=gen_random_uuid();
  UPDATE private.onboarding_deliveries SET status='sending',lease_token=v_token,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=p_id;
  RETURN jsonb_build_object('state','claimed','leaseToken',v_token,'envelope',d.envelope,'envelopeHash',d.envelope_hash,'recipient',d.recipient);
END $$;

CREATE OR REPLACE FUNCTION private.defer_onboarding_delivery(p_id uuid,p_user uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_reason NOT IN ('configuration_unavailable','preparation_failed') THEN RAISE EXCEPTION 'Invalid onboarding deferral' USING ERRCODE='22023'; END IF;
  UPDATE private.onboarding_deliveries SET next_attempt_at=clock_timestamp()+interval '1 hour',last_error=p_reason,updated_at=clock_timestamp()
    WHERE id=p_id AND user_id=p_user AND status='pending';
END $$;

CREATE OR REPLACE FUNCTION private.record_onboarding_outcome(p_id uuid,p_user uuid,p_token uuid,p_kind text,p_code text,p_message text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d private.onboarding_deliveries%ROWTYPE; v_status text;
BEGIN
  SELECT * INTO d FROM private.onboarding_deliveries WHERE id=p_id AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN 'canceled'; END IF;
  IF d.lease_token IS DISTINCT FROM p_token OR d.status NOT IN ('sending','reconciliation') THEN RETURN d.status; END IF;
  IF p_kind='accepted' THEN
    IF p_message IS NULL OR length(btrim(p_message)) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'Invalid onboarding provider receipt' USING ERRCODE='22023'; END IF;
    UPDATE private.onboarding_deliveries SET status='accepted',provider_message_id=p_message,accepted_at=clock_timestamp(),
      envelope=NULL,recipient=NULL,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=p_id;
    RETURN 'accepted';
  END IF;
  IF p_kind='rejected' THEN v_status:='rejected';
  ELSIF p_kind='retry' AND p_code IN ('provider_rate_limit','configuration_unavailable') THEN v_status:='pending';
  ELSE v_status:='reconciliation'; END IF;
  UPDATE private.onboarding_deliveries SET status=v_status,lease_token=CASE WHEN v_status='reconciliation' THEN lease_token ELSE NULL END,lease_until=CASE WHEN v_status='reconciliation' THEN lease_until ELSE NULL END,
    next_attempt_at=clock_timestamp()+interval '5 minutes',last_error=CASE WHEN v_status='pending' THEN p_code WHEN v_status='rejected' THEN 'provider_rejected' ELSE 'delivery_outcome_unknown' END,
    envelope=CASE WHEN v_status='rejected' THEN NULL ELSE envelope END,recipient=CASE WHEN v_status='rejected' THEN NULL ELSE recipient END,
    updated_at=clock_timestamp() WHERE id=p_id;
  RETURN v_status;
END $$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname IN
    ('enqueue_onboarding','onboarding_profile_created','onboarding_context','list_due_onboarding','get_onboarding_delivery','prepare_onboarding_delivery','claim_onboarding_delivery','defer_onboarding_delivery','record_onboarding_outcome') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agsaas_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agsaas_app',f.signature); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
  END LOOP;
END $$;
