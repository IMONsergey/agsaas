-- Own durable bank ingestion. Redis is a wake-up mechanism; SQL owns intent,
-- identity, leases and checkpoints. No credentials are copied into this ledger.
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.bank_sync_operations (
  connection_id uuid PRIMARY KEY REFERENCES public.bank_connections(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_generation bigint NOT NULL DEFAULT 1 CHECK (requested_generation > 0),
  completed_generation bigint NOT NULL DEFAULT 0 CHECK (completed_generation >= 0),
  full_history boolean NOT NULL DEFAULT true,
  lease_token uuid,
  lease_generation bigint,
  lease_account_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz,
  last_error text CHECK (last_error IN ('configuration_unavailable','provider_unavailable','provider_disconnected','invalid_provider_data','lease_expired','no_enabled_accounts')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_generation <= requested_generation),
  CHECK ((lease_token IS NULL AND lease_generation IS NULL AND lease_account_id IS NULL AND lease_until IS NULL)
    OR (lease_token IS NOT NULL AND lease_generation IS NOT NULL AND lease_account_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS bank_sync_operations_due ON private.bank_sync_operations(next_attempt_at, connection_id);
CREATE TABLE IF NOT EXISTS private.bank_sync_account_checkpoints (
  connection_id uuid NOT NULL REFERENCES public.bank_connections(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  generation bigint NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id, account_id)
);
CREATE TABLE IF NOT EXISTS private.bank_sync_webhook_receipts (
  connection_id uuid NOT NULL REFERENCES public.bank_connections(id) ON DELETE CASCADE,
  event_key text NOT NULL CHECK (event_key ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,event_key)
);
REVOKE ALL ON private.bank_sync_operations, private.bank_sync_account_checkpoints, private.bank_sync_webhook_receipts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.request_bank_sync(p_connection uuid,p_team uuid,p_full boolean DEFAULT false,p_event text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_connection public.bank_connections%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM public.bank_connections WHERE id=p_connection AND team_id=p_team FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_event IS NOT NULL THEN
    IF p_event !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid bank event identity' USING ERRCODE='22023'; END IF;
    INSERT INTO private.bank_sync_webhook_receipts(connection_id,event_key) VALUES(p_connection,p_event) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN true; END IF;
  END IF;
  INSERT INTO private.bank_sync_operations(connection_id,team_id,full_history) VALUES(p_connection,p_team,p_full)
  ON CONFLICT(connection_id) DO UPDATE SET
    requested_generation=CASE WHEN bank_sync_operations.lease_token IS NOT NULL AND bank_sync_operations.lease_generation=bank_sync_operations.requested_generation
      THEN bank_sync_operations.requested_generation+1
      ELSE greatest(bank_sync_operations.requested_generation,bank_sync_operations.completed_generation+1) END,
    full_history=bank_sync_operations.full_history OR excluded.full_history,
    last_error=NULL,next_attempt_at=least(bank_sync_operations.next_attempt_at,clock_timestamp()),updated_at=clock_timestamp();
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION private.bank_sync_connection_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.team_id,NEW.provider,NEW.access_token,NEW.reference_id,NEW.enrollment_id,NEW.institution_id,NEW.status,NEW.expires_at)
    IS NOT DISTINCT FROM ROW(OLD.team_id,OLD.provider,OLD.access_token,OLD.reference_id,OLD.enrollment_id,OLD.institution_id,OLD.status,OLD.expires_at) THEN RETURN NEW; END IF;
  INSERT INTO private.bank_sync_operations(connection_id,team_id) VALUES(NEW.id,NEW.team_id)
  ON CONFLICT(connection_id) DO UPDATE SET team_id=excluded.team_id,revision=gen_random_uuid(),
    requested_generation=bank_sync_operations.requested_generation+1,full_history=true,
    lease_token=NULL,lease_generation=NULL,lease_account_id=NULL,lease_until=NULL,
    attempts=0,next_attempt_at=clock_timestamp(),last_error=NULL,updated_at=clock_timestamp();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agsaas_native_bank_connection ON public.bank_connections;
CREATE TRIGGER agsaas_native_bank_connection AFTER INSERT OR UPDATE OF team_id,provider,access_token,reference_id,enrollment_id,institution_id,status,expires_at
  ON public.bank_connections FOR EACH ROW EXECUTE FUNCTION private.bank_sync_connection_changed();

CREATE OR REPLACE FUNCTION private.bank_sync_account_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_connection uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.bank_connection_id,NEW.team_id,NEW.enabled,NEW.manual,NEW.account_id,NEW.type)
    IS NOT DISTINCT FROM ROW(OLD.bank_connection_id,OLD.team_id,OLD.enabled,OLD.manual,OLD.account_id,OLD.type) THEN RETURN NEW; END IF;
  -- The parent connection's INSERT trigger has already created its durable row.
  -- Do not acquire a connection lock while holding the account lock: commits
  -- consistently lock connection (exclusive) -> account -> operation.
  FOR v_connection IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP<>'INSERT' THEN OLD.bank_connection_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.bank_connection_id END]) AS ids(id) WHERE id IS NOT NULL
  LOOP
    UPDATE private.bank_sync_operations SET revision=gen_random_uuid(),requested_generation=requested_generation+1,
      full_history=true,lease_token=NULL,lease_generation=NULL,lease_account_id=NULL,lease_until=NULL,
      next_attempt_at=clock_timestamp(),last_error=NULL,attempts=0,updated_at=clock_timestamp()
      WHERE connection_id=v_connection;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agsaas_native_bank_account ON public.bank_accounts;
CREATE TRIGGER agsaas_native_bank_account AFTER INSERT OR DELETE OR UPDATE OF bank_connection_id,team_id,enabled,manual,account_id,type
  ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION private.bank_sync_account_changed();

-- Installed connections are admitted once; installing this migration does not
-- contact providers or copy any production credentials.
INSERT INTO private.bank_sync_operations(connection_id,team_id)
  SELECT id,team_id FROM public.bank_connections ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION private.list_due_bank_sync(p_limit integer DEFAULT 20)
RETURNS TABLE(connection_id uuid,team_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- Exact webhook dedup is retained for seven days. Bound cleanup work as well.
  DELETE FROM private.bank_sync_webhook_receipts old_receipt WHERE (old_receipt.connection_id,old_receipt.event_key) IN
    (SELECT r.connection_id,r.event_key FROM private.bank_sync_webhook_receipts r WHERE r.received_at<now()-interval '7 days' LIMIT 500);
  RETURN QUERY SELECT s.connection_id,s.team_id FROM private.bank_sync_operations s
    JOIN public.bank_connections c ON c.id=s.connection_id AND c.team_id=s.team_id
    WHERE c.status='connected' AND (c.expires_at IS NULL OR c.expires_at>now())
      AND s.next_attempt_at<=now() AND (s.lease_until IS NULL OR s.lease_until<=now())
    ORDER BY s.next_attempt_at,s.connection_id LIMIT least(greatest(p_limit,1),50);
END $$;

CREATE OR REPLACE FUNCTION private.claim_bank_sync(p_connection uuid,p_team uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.bank_connections%ROWTYPE; s private.bank_sync_operations%ROWTYPE; a public.bank_accounts%ROWTYPE; v_token uuid;
BEGIN
  SELECT * INTO c FROM public.bank_connections WHERE id=p_connection AND team_id=p_team FOR UPDATE;
  IF NOT FOUND OR c.status IS DISTINCT FROM 'connected' OR (c.expires_at IS NOT NULL AND c.expires_at<=now()) THEN RETURN jsonb_build_object('state','canceled'); END IF;
  SELECT * INTO s FROM private.bank_sync_operations WHERE connection_id=p_connection AND team_id=p_team FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','canceled'); END IF;
  IF s.lease_until>clock_timestamp() OR s.next_attempt_at>clock_timestamp() THEN RETURN jsonb_build_object('state','busy'); END IF;
  IF s.requested_generation=s.completed_generation THEN
    UPDATE private.bank_sync_operations SET requested_generation=requested_generation+1 WHERE connection_id=p_connection RETURNING * INTO s;
  END IF;
  SELECT * INTO a FROM public.bank_accounts b WHERE b.bank_connection_id=p_connection AND b.team_id=p_team
    AND b.enabled AND b.manual IS NOT TRUE AND NOT EXISTS
      (SELECT 1 FROM private.bank_sync_account_checkpoints k WHERE k.connection_id=p_connection AND k.account_id=b.id AND k.revision=s.revision AND k.generation>=s.requested_generation)
    ORDER BY b.id LIMIT 1;
  IF NOT FOUND THEN
    UPDATE private.bank_sync_operations SET completed_generation=requested_generation,next_attempt_at=clock_timestamp()+interval '1 day',
      last_error='no_enabled_accounts',lease_token=NULL,lease_generation=NULL,lease_account_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE connection_id=p_connection;
    RETURN jsonb_build_object('state','idle');
  END IF;
  v_token:=gen_random_uuid();
  UPDATE private.bank_sync_operations SET lease_token=v_token,lease_generation=requested_generation,lease_account_id=a.id,
    lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE connection_id=p_connection;
  RETURN jsonb_build_object('state','claimed','leaseToken',v_token,'revision',s.revision,'generation',s.requested_generation,
    'latest',coalesce(NOT s.full_history AND s.last_completed_at>now()-interval '4 days',false),
    'connection',jsonb_build_object('id',c.id,'teamId',c.team_id,'provider',c.provider,'accessToken',c.access_token,
      'referenceId',c.reference_id,'enrollmentId',c.enrollment_id,'institutionId',c.institution_id),
    'account',jsonb_build_object('id',a.id,'accountId',a.account_id,'type',coalesce(a.type::text,'depository'),'currency',a.currency));
END $$;

CREATE OR REPLACE FUNCTION private.bank_sync_lease_active(p_connection uuid,p_team uuid,p_token uuid,p_revision uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM private.bank_sync_operations s
    JOIN public.bank_connections c ON c.id=s.connection_id AND c.team_id=s.team_id
    JOIN public.bank_accounts a ON a.id=s.lease_account_id AND a.bank_connection_id=c.id AND a.team_id=c.team_id
    WHERE s.connection_id=p_connection AND s.team_id=p_team AND s.revision=p_revision AND s.lease_token=p_token
      AND s.lease_until>now() AND a.enabled AND a.manual IS NOT TRUE AND c.status='connected' AND (c.expires_at IS NULL OR c.expires_at>now()))
$$;

CREATE OR REPLACE FUNCTION private.finish_bank_sync_account(p_connection uuid,p_team uuid,p_token uuid,p_revision uuid,p_balance jsonb,p_transactions jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.bank_connections%ROWTYPE; s private.bank_sync_operations%ROWTYPE; a public.bank_accounts%ROWTYPE;
  v_account uuid; v_tx jsonb; v_internal text; v_done boolean; v_category text; v_method text;
BEGIN
  SELECT * INTO c FROM public.bank_connections WHERE id=p_connection AND team_id=p_team FOR UPDATE;
  IF NOT FOUND OR c.status IS DISTINCT FROM 'connected' OR (c.expires_at IS NOT NULL AND c.expires_at<=now()) THEN RETURN false; END IF;
  SELECT lease_account_id INTO v_account FROM private.bank_sync_operations WHERE connection_id=p_connection AND team_id=p_team AND lease_token=p_token AND revision=p_revision;
  SELECT * INTO a FROM public.bank_accounts WHERE id=v_account AND bank_connection_id=p_connection AND team_id=p_team AND enabled AND manual IS NOT TRUE FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO s FROM private.bank_sync_operations WHERE connection_id=p_connection AND team_id=p_team FOR UPDATE;
  IF s.lease_token IS DISTINCT FROM p_token OR s.revision IS DISTINCT FROM p_revision OR s.lease_until<=clock_timestamp() OR s.lease_account_id IS DISTINCT FROM a.id THEN RETURN false; END IF;
  IF p_transactions IS NULL OR jsonb_typeof(p_transactions)<>'array' OR jsonb_array_length(p_transactions)>10000 OR octet_length(p_transactions::text)>16777216 THEN
    RAISE EXCEPTION 'Invalid bank transaction batch' USING ERRCODE='22023';
  END IF;
  FOR v_tx IN SELECT value FROM jsonb_array_elements(p_transactions) LOOP
    IF jsonb_typeof(v_tx)<>'object' OR nullif(v_tx->>'id','') IS NULL OR length(v_tx->>'id')>512
      OR coalesce(v_tx->>'currency','') !~ '^[A-Z]{3}$' OR coalesce(v_tx->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
      OR coalesce(v_tx->>'status','') NOT IN ('posted','pending') OR jsonb_typeof(v_tx->'amount') IS DISTINCT FROM 'number'
      OR abs((v_tx->>'amount')::numeric)>99999999.99 OR (v_tx->>'amount')::numeric IS DISTINCT FROM round((v_tx->>'amount')::numeric,2) OR nullif(v_tx->>'name','') IS NULL
      OR length(v_tx->>'name')>1000 OR length(coalesce(v_tx->>'description',''))>10000 THEN
      RAISE EXCEPTION 'Invalid bank transaction' USING ERRCODE='22023';
    END IF;
    v_internal:=p_team::text||'_'||(v_tx->>'id');
    IF EXISTS(SELECT 1 FROM public.transactions t WHERE t.internal_id=v_internal AND
      (t.team_id<>p_team OR t.bank_account_id IS DISTINCT FROM a.id OR t.manual IS TRUE)) THEN
      RAISE EXCEPTION 'Bank transaction identity conflict' USING ERRCODE='23514';
    END IF;
    SELECT slug INTO v_category FROM public.transaction_categories WHERE team_id=p_team AND slug=v_tx->>'category';
    v_method:=coalesce(v_tx->>'method','other');
    IF NOT EXISTS(SELECT 1 FROM pg_enum WHERE enumtypid='public."transactionMethods"'::regtype AND enumlabel=v_method) THEN v_method:='other'; END IF;
    INSERT INTO public.transactions(team_id,bank_account_id,internal_id,date,name,amount,currency,method,status,balance,description,category_slug,counterparty_name,merchant_name,notified)
    VALUES(p_team,a.id,v_internal,(v_tx->>'date')::date,v_tx->>'name',(v_tx->>'amount')::numeric,v_tx->>'currency',v_method::public."transactionMethods",
      (v_tx->>'status')::public."transactionStatus",(v_tx->>'balance')::numeric,v_tx->>'description',v_category,v_tx->>'counterparty_name',v_tx->>'merchant_name',s.full_history)
    ON CONFLICT(internal_id) DO UPDATE SET date=excluded.date,amount=excluded.amount,currency=excluded.currency,balance=excluded.balance,
      status=CASE WHEN transactions.status IN ('posted','pending') THEN excluded.status WHEN transactions.status='exported' AND (transactions.amount IS DISTINCT FROM excluded.amount OR transactions.date IS DISTINCT FROM excluded.date OR transactions.currency IS DISTINCT FROM excluded.currency) THEN 'posted'::public."transactionStatus" ELSE transactions.status END,
      base_amount=CASE WHEN transactions.amount IS DISTINCT FROM excluded.amount OR transactions.currency IS DISTINCT FROM excluded.currency THEN NULL ELSE transactions.base_amount END,
      base_currency=CASE WHEN transactions.amount IS DISTINCT FROM excluded.amount OR transactions.currency IS DISTINCT FROM excluded.currency THEN NULL ELSE transactions.base_currency END
    WHERE transactions.team_id=p_team AND transactions.bank_account_id=a.id AND transactions.manual IS NOT TRUE;
  END LOOP;
  IF p_balance IS NOT NULL AND p_balance<>'null'::jsonb THEN
    IF jsonb_typeof(p_balance->'amount') IS DISTINCT FROM 'number' OR coalesce(p_balance->>'currency','') !~ '^[A-Z]{3}$' OR p_balance->>'currency'='XXX'
      OR abs((p_balance->>'amount')::numeric)>99999999.99 OR (p_balance->>'amount')::numeric IS DISTINCT FROM round((p_balance->>'amount')::numeric,2) THEN RAISE EXCEPTION 'Invalid bank balance' USING ERRCODE='22023'; END IF;
    UPDATE public.bank_accounts SET balance=(p_balance->>'amount')::numeric,currency=p_balance->>'currency',
      available_balance=(p_balance->>'available_balance')::numeric,credit_limit=(p_balance->>'credit_limit')::numeric,
      base_balance=CASE WHEN balance IS DISTINCT FROM (p_balance->>'amount')::numeric OR currency IS DISTINCT FROM p_balance->>'currency' THEN NULL ELSE base_balance END,
      base_currency=CASE WHEN balance IS DISTINCT FROM (p_balance->>'amount')::numeric OR currency IS DISTINCT FROM p_balance->>'currency' THEN NULL ELSE base_currency END,
      error_details=NULL,error_retries=0 WHERE id=a.id;
  END IF;
  INSERT INTO private.bank_sync_account_checkpoints(connection_id,account_id,revision,generation) VALUES(p_connection,a.id,p_revision,s.lease_generation)
    ON CONFLICT(connection_id,account_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,completed_at=clock_timestamp();
  v_done:=NOT EXISTS(SELECT 1 FROM public.bank_accounts b WHERE b.bank_connection_id=p_connection AND b.team_id=p_team AND b.enabled AND b.manual IS NOT TRUE
    AND NOT EXISTS(SELECT 1 FROM private.bank_sync_account_checkpoints k WHERE k.connection_id=p_connection AND k.account_id=b.id AND k.revision=p_revision AND k.generation>=s.lease_generation));
  UPDATE private.bank_sync_operations SET completed_generation=CASE WHEN v_done THEN s.lease_generation ELSE completed_generation END,
    full_history=CASE WHEN v_done AND requested_generation=s.lease_generation THEN false ELSE full_history END,
    last_completed_at=CASE WHEN v_done THEN clock_timestamp() ELSE last_completed_at END,
    next_attempt_at=CASE WHEN v_done AND requested_generation=s.lease_generation THEN clock_timestamp()+interval '1 day' ELSE clock_timestamp() END,
    lease_token=NULL,lease_generation=NULL,lease_account_id=NULL,lease_until=NULL,attempts=0,last_error=NULL,updated_at=clock_timestamp() WHERE connection_id=p_connection;
  UPDATE public.bank_connections SET last_accessed=clock_timestamp(),error_retries=0,error_details=NULL WHERE id=p_connection;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION private.defer_bank_sync(p_connection uuid,p_team uuid,p_token uuid,p_revision uuid,p_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_code NOT IN ('configuration_unavailable','provider_unavailable','provider_disconnected','invalid_provider_data','lease_expired') THEN RAISE EXCEPTION 'Invalid bank outcome' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.bank_connections WHERE id=p_connection AND team_id=p_team FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE private.bank_sync_operations SET lease_token=NULL,lease_generation=NULL,lease_account_id=NULL,lease_until=NULL,last_error=p_code,
    attempts=CASE WHEN p_code='configuration_unavailable' THEN greatest(attempts-1,0) ELSE attempts END,
    next_attempt_at=clock_timestamp()+CASE WHEN p_code IN ('configuration_unavailable','invalid_provider_data','provider_disconnected') THEN interval '1 hour'
      ELSE least(3600,60*power(2,least(attempts,6)))::integer*interval '1 second' END,updated_at=clock_timestamp()
    WHERE connection_id=p_connection AND team_id=p_team AND lease_token=p_token AND revision=p_revision;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_code='provider_disconnected' THEN UPDATE public.bank_connections SET status='disconnected',error_details='Provider consent is no longer active' WHERE id=p_connection; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION private.bank_sync_status(p_connection uuid,p_team uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('connectionId',s.connection_id,'requestedGeneration',s.requested_generation,'completedGeneration',s.completed_generation,
    'processing',s.lease_until>now(),'nextAttemptAt',s.next_attempt_at,'lastCompletedAt',s.last_completed_at,'reason',CASE WHEN c.status IS DISTINCT FROM 'connected' OR (c.expires_at IS NOT NULL AND c.expires_at<=now()) THEN 'provider_disconnected' ELSE s.last_error END)
    FROM private.bank_sync_operations s JOIN public.bank_connections c ON c.id=s.connection_id AND c.team_id=s.team_id WHERE s.connection_id=p_connection AND s.team_id=p_team
$$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname IN
    ('request_bank_sync','list_due_bank_sync','claim_bank_sync','bank_sync_lease_active','finish_bank_sync_account','defer_bank_sync','bank_sync_status','bank_sync_connection_changed','bank_sync_account_changed') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agsaas_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agsaas_app',f.signature); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
  END LOOP;
END $$;

-- Browser Data API must not manufacture provider-owned account references.
-- All account mutation UI uses the authenticated own API; column privileges
-- are revoked too, because table REVOKE alone does not remove column grants.
REVOKE INSERT,UPDATE,DELETE ON public.bank_accounts,public.bank_connections FROM PUBLIC,anon,authenticated;
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts','bank_connections'] LOOP
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE INSERT(%I),UPDATE(%I) ON public.%I FROM PUBLIC,anon,authenticated',c.attname,c.attname,t);
    END LOOP;
  END LOOP;
END $$;
