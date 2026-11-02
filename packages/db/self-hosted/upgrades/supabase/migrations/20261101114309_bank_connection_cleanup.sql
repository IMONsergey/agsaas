-- Additive migration created with pinned Supabase CLI 2.84.6.
-- No historical deletions or provider requests are backfilled.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.bank_connection_cleanups') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected existing bank connection cleanup schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agsaas_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb) THEN
    RAISE EXCEPTION 'Dedicated nonprivileged agsaas_app role is required';
  END IF;
END $$;

CREATE TABLE public.bank_connection_cleanups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Deliberately no FK: this intent MUST survive account/team/connection deletion.
  team_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text,
  encrypted_payload text,
  status text DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  dispatch_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT bank_connection_cleanups_connection_key UNIQUE(connection_id),
  CONSTRAINT bank_connection_cleanups_status_check CHECK (status IN ('pending','processing','completed','reconciliation')),
  CONSTRAINT bank_connection_cleanups_provider_check CHECK (provider IS NULL OR provider IN ('plaid','gocardless','teller','enablebanking')),
  CONSTRAINT bank_connection_cleanups_attempts_check CHECK (attempts >= 0),
  CONSTRAINT bank_connection_cleanups_payload_check CHECK (
    ((status = 'completed' AND encrypted_payload IS NULL AND completed_at IS NOT NULL) OR
     (status <> 'completed' AND encrypted_payload IS NOT NULL AND octet_length(encrypted_payload) BETWEEN 44 AND 65536 AND completed_at IS NULL)) IS TRUE
  ),
  CONSTRAINT bank_connection_cleanups_fence_check CHECK (status <> 'processing' OR (dispatch_token IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL))
);
CREATE INDEX bank_connection_cleanups_recovery_idx ON public.bank_connection_cleanups(status, next_attempt_at);
CREATE INDEX bank_connection_cleanups_team_idx ON public.bank_connection_cleanups(team_id, updated_at);
ALTER TABLE public.bank_connection_cleanups ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.bank_connection_cleanups AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.bank_connection_cleanups FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_connection_cleanups TO agsaas_app, service_role;
COMMENT ON TABLE public.bank_connection_cleanups IS 'Private encrypted provider cleanup intent committed with local deletion. Success immediately erases credentials; ambiguous attempts require reconciliation. No legacy replay.';
