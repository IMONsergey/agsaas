-- Additive migration created with Supabase CLI 2.84.6. No old jobs or mail
-- are backfilled. Apply transactionally after the earlier delivery upgrades.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.notification_dispatches') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected existing generic notification dispatch schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agsaas_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb) THEN
    RAISE EXCEPTION 'Dedicated nonprivileged agsaas_app role is required';
  END IF;
END $$;

CREATE TABLE public.notification_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  kind text NOT NULL,
  source_job_id text NOT NULL,
  payload jsonb,
  payload_hash text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  dispatch_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  outcome jsonb,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT notification_dispatches_team_operation_key UNIQUE(team_id, operation_key),
  CONSTRAINT notification_dispatches_kind_check CHECK (kind IN ('notification','payment-issue','recurring-upcoming')),
  CONSTRAINT notification_dispatches_status_check CHECK (status IN ('pending','dispatching','completed','rejected','reconciliation')),
  CONSTRAINT notification_dispatches_attempts_check CHECK (attempts >= 0),
  CONSTRAINT notification_dispatches_identity_check CHECK (operation_key ~ '^[a-f0-9]{64}$' AND payload_hash ~ '^[a-f0-9]{64}$' AND length(source_job_id) BETWEEN 1 AND 512),
  CONSTRAINT notification_dispatches_payload_check CHECK (
    (payload IS NULL AND status IN ('completed','rejected','reconciliation')) OR
    (payload IS NOT NULL AND jsonb_typeof(payload) = 'object' AND payload->>'teamId' IS NOT NULL AND payload->>'teamId' = team_id::text AND octet_length(payload::text) <= 524288)
  ),
  CONSTRAINT notification_dispatches_fence_check CHECK (status <> 'dispatching' OR (dispatch_token IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL))
);
CREATE INDEX notification_dispatches_recovery_idx ON public.notification_dispatches(status, next_attempt_at);
ALTER TABLE public.notification_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.notification_dispatches AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.notification_dispatches FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_dispatches TO agsaas_app, service_role;
COMMENT ON TABLE public.notification_dispatches IS 'Private generic notification intent and acceptance ledger. Partial or uncertain dispatch requires reconciliation; accepted does not mean delivered. No legacy replay.';
