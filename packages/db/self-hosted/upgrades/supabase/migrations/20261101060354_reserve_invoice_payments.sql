-- Run once, transactionally, after the immutable baseline and prior upgrades.
-- No existing invoice or provider state is rewritten or backfilled.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.invoices IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.invoice_payment_reservations') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.invoices'::regclass
        AND conname = 'invoices_id_team_id_key'
    ) THEN
    RAISE EXCEPTION 'Unexpected existing invoice payment reservation schema';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.invoices'::regclass
        AND attname IN ('id', 'team_id') AND atttypid = 'uuid'::regtype
        AND attnotnull AND NOT attisdropped) <> 2
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.invoices'::regclass
        AND attname = 'amount' AND format_type(atttypid, atttypmod) = 'numeric(10,2)'
        AND NOT attisdropped
    ) THEN
    RAISE EXCEPTION 'Unexpected invoice identity or amount storage contract';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'agsaas_app' AND rolcanlogin AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
  ) THEN
    RAISE EXCEPTION 'Dedicated nonprivileged agsaas_app role is required';
  END IF;
END
$$;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_id_team_id_key UNIQUE (id, team_id);

CREATE TABLE public.invoice_payment_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  team_id uuid NOT NULL,
  stripe_account_id text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  invoice_number text NOT NULL,
  payment_intent_id text,
  state text NOT NULL DEFAULT 'reserved',
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_payment_reservations_invoice_id_key UNIQUE (invoice_id),
  CONSTRAINT invoice_payment_reservations_invoice_team_fkey
    FOREIGN KEY (invoice_id, team_id) REFERENCES public.invoices(id, team_id) ON DELETE CASCADE,
  CONSTRAINT invoice_payment_reservations_amount_check CHECK (amount_minor BETWEEN 1 AND 99999999),
  CONSTRAINT invoice_payment_reservations_currency_check CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT invoice_payment_reservations_state_check CHECK (state IN ('reserved', 'attached', 'reconciliation_required')),
  CONSTRAINT invoice_payment_reservations_attached_check CHECK (state <> 'attached' OR payment_intent_id IS NOT NULL)
);

CREATE INDEX invoice_payment_reservations_team_id_idx
  ON public.invoice_payment_reservations(team_id);

ALTER TABLE public.invoice_payment_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.invoice_payment_reservations
  AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.invoice_payment_reservations
  FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_payment_reservations
  TO agsaas_app, service_role;

COMMENT ON TABLE public.invoice_payment_reservations IS
  'Internal immutable Stripe handoff. Unknown/expired attempts require reconciliation; never delete to retry a charge.';
