-- One transaction, application baseline and packet01/02 upgrades already applied.
-- This server-only receipt table is deliberately not exposed to PostgREST users.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.invoice_email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  operation_key text NOT NULL,
  kind text NOT NULL,
  expected_scheduled_job_id text,
  recipient text NOT NULL,
  envelope text,
  envelope_hash text NOT NULL,
  activity_snapshot jsonb NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  accepted_at timestamptz,
  completed_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT invoice_email_deliveries_kind_check CHECK (kind IN ('invoice', 'reminder')),
  CONSTRAINT invoice_email_deliveries_state_check CHECK (status IN ('pending', 'sending', 'accepted', 'completed', 'reconciliation', 'canceled', 'rejected')),
  CONSTRAINT invoice_email_deliveries_attempts_check CHECK (attempts >= 0),
  CONSTRAINT invoice_email_deliveries_envelope_check CHECK (
    (status = 'completed' AND envelope IS NULL) OR
    (status <> 'completed' AND envelope IS NOT NULL AND octet_length(envelope) <= 4194304)
  ),
  CONSTRAINT invoice_email_deliveries_receipt_check CHECK (
    status NOT IN ('accepted', 'completed') OR
    (provider_message_id IS NOT NULL AND length(provider_message_id) > 0 AND accepted_at IS NOT NULL)
  ),
  CONSTRAINT invoice_email_deliveries_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE,
  CONSTRAINT invoice_email_deliveries_invoice_id_fkey
    FOREIGN KEY (invoice_id, team_id) REFERENCES public.invoices(id, team_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX invoice_email_deliveries_operation_idx
  ON public.invoice_email_deliveries (team_id, operation_key);
CREATE INDEX invoice_email_deliveries_invoice_idx
  ON public.invoice_email_deliveries (invoice_id);
CREATE INDEX invoice_email_deliveries_recovery_idx
  ON public.invoice_email_deliveries (status, next_attempt_at);

ALTER TABLE public.invoice_email_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.invoice_email_deliveries
  AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.invoice_email_deliveries
  FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_email_deliveries
  TO agsaas_app, service_role;
