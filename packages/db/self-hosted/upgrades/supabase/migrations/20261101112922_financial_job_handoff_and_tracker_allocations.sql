-- Additive migration created with Supabase CLI 2.84.6. Apply transactionally.
-- No historical draft is guessed to be approved for sending; no legacy mail is replayed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
  IF to_regclass('public.financial_job_dispatches') IS NOT NULL OR to_regclass('public.manual_transaction_operations') IS NOT NULL OR to_regclass('public.tracker_invoice_allocations') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected existing financial job handoff schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agsaas_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb) THEN
    RAISE EXCEPTION 'Dedicated nonprivileged agsaas_app role is required';
  END IF;
END $$;

CREATE TABLE public.financial_job_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  job_name text NOT NULL,
  queue_name text NOT NULL,
  payload jsonb,
  payload_hash text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT financial_job_dispatches_operation_key UNIQUE(team_id, operation_key),
  CONSTRAINT financial_job_dispatches_status_check CHECK(status IN ('pending','accepted','completed','failed') AND attempts >= 0),
  CONSTRAINT financial_job_dispatches_hash_check CHECK(operation_key ~ '^[a-f0-9]{64}$' AND payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT financial_job_dispatches_queue_check CHECK((job_name,queue_name) IN (('generate-invoice','invoices'),('enrich-transactions','transactions'),('match-transactions-bidirectional','inbox'),('notification','notifications'))),
  CONSTRAINT financial_job_dispatches_payload_check CHECK(((payload IS NULL AND status = 'completed') OR (payload IS NOT NULL AND jsonb_typeof(payload) = 'object' AND payload->>'teamId' = team_id::text AND octet_length(payload::text) <= 65536)) IS TRUE)
);
CREATE INDEX financial_job_dispatches_recovery_idx ON public.financial_job_dispatches(next_attempt_at) WHERE status IN ('pending','accepted');
ALTER TABLE public.financial_job_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.financial_job_dispatches AS PERMISSIVE FOR ALL TO agsaas_app USING(true) WITH CHECK(true);

CREATE TABLE public.manual_transaction_operations (
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT manual_transaction_operations_pkey PRIMARY KEY(team_id,operation_id),
  CONSTRAINT manual_transaction_operations_hash_check CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE public.manual_transaction_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.manual_transaction_operations AS PERMISSIVE FOR ALL TO agsaas_app USING(true) WITH CHECK(true);

REVOKE ALL ON public.financial_job_dispatches, public.manual_transaction_operations FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_job_dispatches, public.manual_transaction_operations TO agsaas_app, service_role;

CREATE FUNCTION public.guard_financial_job_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.id,NEW.team_id,NEW.operation_key,NEW.job_name,NEW.queue_name,NEW.payload_hash) IS DISTINCT FROM ROW(OLD.id,OLD.team_id,OLD.operation_key,OLD.job_name,OLD.queue_name,OLD.payload_hash)
    OR (NEW.payload IS DISTINCT FROM OLD.payload AND NOT (NEW.status = 'completed' AND NEW.payload IS NULL))
    OR (OLD.status IN ('completed','failed') AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'Financial job identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_job_dispatches_identity BEFORE UPDATE ON public.financial_job_dispatches FOR EACH ROW EXECUTE FUNCTION public.guard_financial_job_identity();
REVOKE ALL ON FUNCTION public.guard_financial_job_identity() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.financial_job_dispatches IS 'Private transactional queue intents. Accepted is queue acceptance, completed is observed worker completion; failed requires review. Persisted invoice delivery keys survive Redis recreation.';
COMMENT ON TABLE public.manual_transaction_operations IS 'Private manual transaction idempotency receipts. A deleted transaction leaves a tombstone; retry cannot recreate it.';

-- Legacy billed flags remain unchanged. No guessed historical allocation is created.
CREATE TABLE public.tracker_invoice_allocations (
  tracker_entry_id uuid PRIMARY KEY NOT NULL REFERENCES public.tracker_entries(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  duration bigint NOT NULL,
  rate numeric(10,2) NOT NULL,
  currency text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT tracker_invoice_allocations_amount_check CHECK(duration > 0 AND rate > 0 AND currency ~ '^[A-Z]{3}$')
);
CREATE INDEX tracker_invoice_allocations_invoice_idx ON public.tracker_invoice_allocations(team_id,invoice_id);
ALTER TABLE public.tracker_invoice_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.tracker_invoice_allocations AS PERMISSIVE FOR ALL TO agsaas_app USING(true) WITH CHECK(true);
REVOKE ALL ON public.tracker_invoice_allocations FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tracker_invoice_allocations TO agsaas_app, service_role;

CREATE FUNCTION public.guard_tracker_invoice_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE document public.invoices; entry public.tracker_entries;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Tracker invoice allocation is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = OLD.team_id) THEN RETURN OLD; END IF;
    SELECT * INTO document FROM public.invoices WHERE id = OLD.invoice_id AND team_id = OLD.team_id FOR UPDATE;
    IF NOT FOUND OR document.document_snapshot IS NOT NULL OR document.status NOT IN ('draft','canceled') THEN
      RAISE EXCEPTION 'Issued tracked time must remain linked to its invoice';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO document FROM public.invoices WHERE id = NEW.invoice_id AND team_id = NEW.team_id FOR UPDATE;
  IF NOT FOUND OR document.status <> 'draft' OR document.document_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'Tracked time requires an unissued draft in the same team';
  END IF;
  SELECT * INTO entry FROM public.tracker_entries WHERE id = NEW.tracker_entry_id AND team_id = NEW.team_id FOR UPDATE;
  IF NOT FOUND OR entry.billed IS TRUE OR (entry.start IS NOT NULL AND entry.stop IS NULL)
    OR NEW.duration IS DISTINCT FROM entry.duration OR NEW.rate IS DISTINCT FROM entry.rate
    OR NEW.currency IS DISTINCT FROM upper(entry.currency) OR NEW.currency IS DISTINCT FROM upper(document.currency) THEN
    RAISE EXCEPTION 'Tracked time allocation does not match unbilled source time';
  END IF;
  UPDATE public.tracker_entries SET billed = true WHERE id = NEW.tracker_entry_id AND team_id = NEW.team_id;
  RETURN NEW;
END $$;
CREATE TRIGGER tracker_invoice_allocations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tracker_invoice_allocations FOR EACH ROW EXECUTE FUNCTION public.guard_tracker_invoice_allocation();

CREATE FUNCTION public.guard_allocated_tracker_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE allocated boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = OLD.team_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.tracker_invoice_allocations WHERE tracker_entry_id = OLD.id) INTO allocated;
  IF TG_OP = 'DELETE' THEN
    IF OLD.billed IS TRUE OR allocated THEN RAISE EXCEPTION 'Allocated tracked time cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF ((OLD.billed IS TRUE OR allocated) AND ROW(NEW.team_id,NEW.project_id,NEW.date,NEW.start,NEW.stop,NEW.duration,NEW.rate,NEW.currency) IS DISTINCT FROM ROW(OLD.team_id,OLD.project_id,OLD.date,OLD.start,OLD.stop,OLD.duration,OLD.rate,OLD.currency))
    OR (allocated AND NEW.billed IS NOT TRUE) THEN
    RAISE EXCEPTION 'Allocated tracked time cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tracker_entries_allocation_guard BEFORE UPDATE OR DELETE ON public.tracker_entries FOR EACH ROW EXECUTE FUNCTION public.guard_allocated_tracker_entry();

CREATE FUNCTION public.release_draft_tracker_allocations() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE entry_ids uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = OLD.team_id) THEN RETURN OLD; END IF;
  SELECT array_agg(tracker_entry_id) INTO entry_ids FROM public.tracker_invoice_allocations WHERE invoice_id = OLD.id AND team_id = OLD.team_id;
  IF entry_ids IS NULL THEN RETURN OLD; END IF;
  IF OLD.document_snapshot IS NOT NULL OR OLD.status NOT IN ('draft','canceled') THEN
    RAISE EXCEPTION 'Issued tracked time must remain linked to its invoice';
  END IF;
  DELETE FROM public.tracker_invoice_allocations WHERE invoice_id = OLD.id AND team_id = OLD.team_id;
  UPDATE public.tracker_entries SET billed = false WHERE id = ANY(entry_ids) AND team_id = OLD.team_id;
  RETURN OLD;
END $$;
CREATE TRIGGER invoices_release_tracker_allocations BEFORE DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.release_draft_tracker_allocations();
REVOKE ALL ON FUNCTION public.guard_tracker_invoice_allocation(), public.guard_allocated_tracker_entry(), public.release_draft_tracker_allocations() FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.tracker_invoice_allocations IS 'Whole closed time entries reserved by a single invoice, with immutable duration/rate/currency. Deleting an unissued draft releases its reservation; issued allocations remain historical evidence.';
