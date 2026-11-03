-- Append-only confirmed money events. No backfill invents legacy settlement history.
CREATE TABLE public.invoice_settlement_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK(operation_key ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('payment','refund','refund_reversal')),
  amount_minor bigint NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK(currency ~ '^[a-z]{3}$'),
  payment_id uuid REFERENCES public.invoice_settlement_entries(id),
  reverses_id uuid REFERENCES public.invoice_settlement_entries(id),
  provider text NOT NULL CHECK(provider IN ('manual','stripe','bank')),
  provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 256),
  provider_resource_id text NOT NULL CHECK(length(provider_resource_id) BETWEEN 1 AND 256),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT invoice_settlement_entries_invoice_team_fkey FOREIGN KEY(invoice_id,team_id) REFERENCES public.invoices(id,team_id) ON DELETE CASCADE,
  CHECK((kind='payment' AND payment_id IS NULL AND reverses_id IS NULL) OR
        (kind='refund' AND payment_id IS NOT NULL AND reverses_id IS NULL) OR
        (kind='refund_reversal' AND payment_id IS NOT NULL AND reverses_id IS NOT NULL))
);
CREATE UNIQUE INDEX invoice_settlement_operation_unique ON public.invoice_settlement_entries(team_id,operation_key);
CREATE UNIQUE INDEX invoice_settlement_resource_unique ON public.invoice_settlement_entries(provider,provider_account_id,provider_resource_id,kind);
CREATE INDEX invoice_settlement_entries_invoice_idx ON public.invoice_settlement_entries(team_id,invoice_id,created_at,id);
CREATE TABLE public.invoice_settlement_state (
  invoice_id uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  projection jsonb NOT NULL,
  entry_count integer NOT NULL CHECK(entry_count>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reconciliation_required boolean NOT NULL DEFAULT false,
  reason text,
  CONSTRAINT invoice_settlement_state_invoice_team_fkey FOREIGN KEY(invoice_id,team_id) REFERENCES public.invoices(id,team_id) ON DELETE CASCADE
);
CREATE FUNCTION public.guard_invoice_settlement_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  -- Explicit team/invoice erasure retains the existing cascade behavior. Direct journal edits are forbidden.
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
     AND (to_jsonb(NEW)-'actor_id')=(to_jsonb(OLD)-'actor_id') AND pg_trigger_depth()>1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Confirmed settlement entries are immutable';
END $$;
CREATE TRIGGER invoice_settlement_immutable BEFORE UPDATE OR DELETE ON public.invoice_settlement_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_settlement_entry();
ALTER TABLE public.invoice_settlement_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_settlement_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_settlement_entries,public.invoice_settlement_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.invoice_settlement_entries TO agsaas_app;
GRANT SELECT,INSERT,UPDATE ON public.invoice_settlement_state TO agsaas_app;

CREATE POLICY invoice_settlement_backend ON public.invoice_settlement_entries TO agsaas_app USING(true) WITH CHECK(true);
CREATE POLICY invoice_settlement_state_backend ON public.invoice_settlement_state TO agsaas_app USING(true) WITH CHECK(true);
CREATE FUNCTION public.validate_invoice_settlement_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE original public.invoice_settlement_entries; reversal_total numeric; net_refunds numeric; invoice_currency text;
BEGIN
  SELECT lower(currency) INTO invoice_currency FROM public.invoices WHERE id=NEW.invoice_id AND team_id=NEW.team_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement invoice does not belong to team'; END IF;
  IF invoice_currency IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'Settlement currency does not match invoice'; END IF;
  IF NEW.provider='manual' AND NEW.provider_account_id<>NEW.team_id::text THEN RAISE EXCEPTION 'Manual settlement account must be its team'; END IF;
  IF NEW.kind<>'payment' THEN
    SELECT * INTO original FROM public.invoice_settlement_entries WHERE id=NEW.payment_id AND kind='payment'
      AND invoice_id=NEW.invoice_id AND team_id=NEW.team_id AND currency=NEW.currency
      AND provider=NEW.provider AND provider_account_id=NEW.provider_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Refund does not belong to its original payment'; END IF;
    SELECT COALESCE(sum(CASE WHEN kind='refund' THEN amount_minor ELSE -amount_minor END),0)
      INTO net_refunds FROM public.invoice_settlement_entries WHERE payment_id=NEW.payment_id;
    net_refunds := net_refunds + CASE WHEN NEW.kind='refund' THEN NEW.amount_minor ELSE -NEW.amount_minor END;
    IF net_refunds<0 OR net_refunds>original.amount_minor THEN RAISE EXCEPTION 'Refund exceeds remaining confirmed payment'; END IF;
    IF NEW.kind='refund_reversal' THEN
      SELECT * INTO original FROM public.invoice_settlement_entries WHERE id=NEW.reverses_id AND kind='refund'
        AND payment_id=NEW.payment_id AND invoice_id=NEW.invoice_id AND team_id=NEW.team_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Refund reversal has no matching original refund'; END IF;
      SELECT COALESCE(sum(amount_minor),0) INTO reversal_total FROM public.invoice_settlement_entries WHERE reverses_id=NEW.reverses_id;
      IF reversal_total+NEW.amount_minor>original.amount_minor THEN RAISE EXCEPTION 'Refund reversal exceeds original refund'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_settlement_validate BEFORE INSERT ON public.invoice_settlement_entries
FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_settlement_entry();

-- Completed attempts remain auditable; only an unresolved attempt occupies the checkout slot.
ALTER TABLE public.invoice_payment_reservations DROP CONSTRAINT invoice_payment_reservations_invoice_id_key;
ALTER TABLE public.invoice_payment_reservations DROP CONSTRAINT invoice_payment_reservations_state_check;
ALTER TABLE public.invoice_payment_reservations ADD CONSTRAINT invoice_payment_reservations_state_check CHECK(state IN ('reserved','attached','settled','reconciliation_required'));
ALTER TABLE public.invoice_payment_reservations DROP CONSTRAINT invoice_payment_reservations_attached_check;
ALTER TABLE public.invoice_payment_reservations ADD CONSTRAINT invoice_payment_reservations_attached_check CHECK(state NOT IN ('attached','settled') OR payment_intent_id IS NOT NULL);
CREATE UNIQUE INDEX invoice_payment_reservations_active_unique ON public.invoice_payment_reservations(invoice_id) WHERE state<>'settled';
CREATE UNIQUE INDEX invoice_payment_reservations_intent_unique ON public.invoice_payment_reservations(stripe_account_id,payment_intent_id) WHERE payment_intent_id IS NOT NULL;
