-- A refund request is durable before external POST. No legacy refund is guessed or backfilled.
CREATE TABLE public.invoice_refund_requests (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  payment_entry_id uuid NOT NULL REFERENCES public.invoice_settlement_entries(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  stripe_account_id text NOT NULL CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  payment_amount_minor bigint NOT NULL CHECK (payment_amount_minor BETWEEN 1 AND 99999999),
  refund_amount_minor bigint NOT NULL CHECK (refund_amount_minor BETWEEN 1 AND payment_amount_minor),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key = 'invoice-refund/' || id::text || '/v2'),
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','unknown','bound','settled','failed','manual_unknown')),
  provider_refund_id text CHECK (provider_refund_id ~ '^(re|pyr)_[A-Za-z0-9]+$'),
  provider_status text CHECK (provider_status IN ('pending','requires_action','succeeded','failed','canceled')),
  binding_verified boolean NOT NULL DEFAULT false,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token uuid,
  claim_expires_at timestamptz,
  failure_code text CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT invoice_refund_request_invoice_team_fkey FOREIGN KEY(invoice_id,team_id) REFERENCES public.invoices(id,team_id) ON DELETE CASCADE,
  UNIQUE (team_id,operation_id),
  UNIQUE (idempotency_key),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (claim_token IS NULL OR (state='unknown' AND attempt_count>0 AND last_attempt_at IS NOT NULL AND
    claim_expires_at>last_attempt_at AND claim_expires_at<=last_attempt_at+interval '30 seconds')),
  CHECK (state<>'reserved' OR (attempt_count=0 AND provider_refund_id IS NULL AND provider_status IS NULL AND NOT binding_verified)),
  CHECK (state<>'unknown' OR attempt_count>0),
  CHECK (state<>'bound' OR (binding_verified AND provider_status IS NOT NULL)),
  CHECK ((attempt_count = 0 AND first_attempt_at IS NULL AND last_attempt_at IS NULL) OR
         (attempt_count > 0 AND first_attempt_at IS NOT NULL AND last_attempt_at IS NOT NULL AND last_attempt_at >= first_attempt_at AND first_attempt_at >= created_at)),
  CHECK (NOT binding_verified OR provider_refund_id IS NOT NULL),
  CHECK (state NOT IN ('bound','settled','failed') OR provider_refund_id IS NOT NULL),
  CHECK (state <> 'unknown' OR provider_refund_id IS NULL),
  CHECK (state <> 'settled' OR (binding_verified AND provider_status IS NOT NULL AND provider_status='succeeded' AND claim_token IS NULL)),
  CHECK (state <> 'failed' OR (binding_verified AND provider_status IS NOT NULL AND provider_status IN ('failed','canceled') AND claim_token IS NULL))
);
CREATE UNIQUE INDEX invoice_refund_requests_active_unique ON public.invoice_refund_requests(invoice_id)
  WHERE state NOT IN ('settled','failed');
CREATE UNIQUE INDEX invoice_refund_requests_resource_unique ON public.invoice_refund_requests(stripe_account_id,provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX invoice_refund_requests_team_idx ON public.invoice_refund_requests(team_id,invoice_id,created_at,id);

CREATE FUNCTION public.guard_invoice_refund_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $agsaas$
DECLARE payment public.invoice_settlement_entries;
BEGIN
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 AND OLD.state IN ('settled','failed') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Refund requests cannot be erased before their provider outcome is reconciled';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.invoices WHERE id=NEW.invoice_id AND team_id=NEW.team_id FOR UPDATE;
    SELECT * INTO payment FROM public.invoice_settlement_entries WHERE id=NEW.payment_entry_id;
    IF NOT FOUND OR payment.kind<>'payment' OR payment.provider<>'stripe' OR
      payment.invoice_id<>NEW.invoice_id OR payment.team_id<>NEW.team_id OR payment.currency<>NEW.currency OR
      payment.provider_account_id<>NEW.stripe_account_id OR payment.provider_resource_id<>NEW.payment_intent_id OR
      payment.amount_minor<>NEW.payment_amount_minor THEN
      RAISE EXCEPTION 'Refund request does not belong to its original confirmed payment';
    END IF;
    IF NEW.state<>'reserved' OR NEW.provider_refund_id IS NOT NULL OR NEW.binding_verified OR NEW.attempt_count<>0 OR
      NEW.claim_token IS NOT NULL OR NEW.provider_status IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.created_at>clock_timestamp() THEN
      RAISE EXCEPTION 'A new refund request must start with an unattempted immutable intent';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth()>1 AND OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL AND
    (to_jsonb(NEW)-'actor_id')=(to_jsonb(OLD)-'actor_id') THEN RETURN NEW; END IF;
  IF ROW(NEW.id,NEW.team_id,NEW.invoice_id,NEW.payment_entry_id,NEW.operation_id,NEW.stripe_account_id,NEW.payment_intent_id,
    NEW.payment_amount_minor,NEW.refund_amount_minor,NEW.currency,NEW.request_hash,NEW.idempotency_key,NEW.actor_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.team_id,OLD.invoice_id,OLD.payment_entry_id,OLD.operation_id,OLD.stripe_account_id,OLD.payment_intent_id,
    OLD.payment_amount_minor,OLD.refund_amount_minor,OLD.currency,OLD.request_hash,OLD.idempotency_key,OLD.actor_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Refund request financial identity is immutable';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'Refund provider identity is write once';
  END IF;
  IF OLD.binding_verified AND NOT NEW.binding_verified THEN RAISE EXCEPTION 'Refund provider binding cannot be forgotten'; END IF;
  IF OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at THEN
    RAISE EXCEPTION 'Refund replay age cannot be extended';
  END IF;
  IF OLD.state IN ('settled','failed') AND (NEW.state<>OLD.state OR NEW.provider_status IS DISTINCT FROM OLD.provider_status) THEN
    RAISE EXCEPTION 'A resolved refund request cannot be rewritten or redispatched';
  END IF;
  IF OLD.state<>'reserved' AND NEW.state='reserved' THEN RAISE EXCEPTION 'A refund request cannot forget its dispatch state'; END IF;
  IF OLD.state NOT IN ('reserved','unknown') AND NEW.state='unknown' THEN RAISE EXCEPTION 'A bound or blocked refund cannot be redispatched'; END IF;
  IF NEW.state IN ('settled','failed') AND OLD.state NOT IN ('settled','failed') THEN
    IF OLD.state<>'bound' OR NOT OLD.binding_verified OR OLD.provider_refund_id IS NULL THEN
      RAISE EXCEPTION 'A terminal refund requires a previously retained verified provider binding';
    END IF;
    IF NEW.state='settled' AND NOT EXISTS (
      SELECT 1 FROM public.invoice_settlement_entries entry WHERE entry.team_id=NEW.team_id AND entry.invoice_id=NEW.invoice_id
        AND entry.kind='refund' AND entry.provider='stripe' AND entry.payment_id=NEW.payment_entry_id
        AND entry.provider_account_id=NEW.stripe_account_id AND entry.provider_resource_id=NEW.provider_refund_id
        AND entry.amount_minor=NEW.refund_amount_minor AND entry.currency=NEW.currency
    ) THEN RAISE EXCEPTION 'A settled refund requires its exact confirmed journal entry'; END IF;
  END IF;
  IF NEW.updated_at<=OLD.updated_at THEN RAISE EXCEPTION 'Refund observation revision must advance'; END IF;
  IF NEW.attempt_count=OLD.attempt_count THEN
    IF OLD.claim_token IS NOT NULL AND OLD.claim_expires_at>clock_timestamp() AND NEW.state='unknown' AND NEW.claim_token IS NULL THEN
      RAISE EXCEPTION 'A live unknown refund claim cannot be released before its lease expires';
    END IF;
    IF NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at OR
      (NEW.claim_token IS NOT NULL AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at)) THEN
      RAISE EXCEPTION 'Only a new refund dispatch may claim or advance its attempt clock';
    END IF;
  ELSIF NEW.attempt_count=OLD.attempt_count+1 THEN
    IF NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN RAISE EXCEPTION 'Each refund dispatch requires a fresh claim token'; END IF;
    IF OLD.state NOT IN ('reserved','unknown') OR NEW.state<>'unknown' OR NEW.provider_refund_id IS NOT NULL OR
      NEW.claim_token IS NULL OR NEW.last_attempt_at IS NULL OR NEW.last_attempt_at<OLD.created_at OR
      (OLD.last_attempt_at IS NOT NULL AND NEW.last_attempt_at<OLD.last_attempt_at) OR
      NEW.last_attempt_at>clock_timestamp() OR NEW.last_attempt_at>=OLD.created_at+interval '23 hours' OR
      clock_timestamp()>=OLD.created_at+interval '23 hours' OR NEW.claim_expires_at<=clock_timestamp() OR
      (OLD.claim_expires_at IS NOT NULL AND OLD.claim_expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Unknown refund dispatch is outside its safe replay window or still claimed';
    END IF;
  ELSE RAISE EXCEPTION 'Refund attempt sequence cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$agsaas$;
CREATE TRIGGER invoice_refund_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_refund_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_refund_request();
ALTER TABLE public.invoice_refund_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_refund_requests FROM PUBLIC,anon,authenticated,service_role,agsaas_app;
GRANT SELECT,INSERT,UPDATE ON public.invoice_refund_requests TO agsaas_app;
CREATE POLICY invoice_refund_requests_backend ON public.invoice_refund_requests TO agsaas_app USING(true) WITH CHECK(true);
