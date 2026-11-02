-- Additive migration, created with Supabase CLI 2.84.6. Run transactionally
-- after packet03. Existing pending invites are deliberately NOT backfilled.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.user_invites IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF to_regclass('public.team_invite_deliveries') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.user_invites'::regclass AND conname = 'user_invites_id_team_id_key') THEN
    RAISE EXCEPTION 'Unexpected existing invitation delivery schema';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid = 'public.user_invites'::regclass AND attname IN ('id','team_id') AND atttypid = 'uuid'::regtype AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION 'Unexpected invitation identity storage contract';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agsaas_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb) THEN
    RAISE EXCEPTION 'Dedicated nonprivileged agsaas_app role is required';
  END IF;
END $$;

ALTER TABLE public.user_invites ADD CONSTRAINT user_invites_id_team_id_key UNIQUE (id, team_id);
CREATE TABLE public.team_invite_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL,
  invite_id uuid NOT NULL,
  recipient text NOT NULL,
  context jsonb NOT NULL,
  envelope text,
  envelope_hash text,
  status text DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  accepted_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT team_invite_deliveries_invite_key UNIQUE (invite_id),
  CONSTRAINT team_invite_deliveries_state_check CHECK (status IN ('pending','sending','accepted','reconciliation','canceled','rejected')),
  CONSTRAINT team_invite_deliveries_attempts_check CHECK (attempts >= 0),
  CONSTRAINT team_invite_deliveries_envelope_check CHECK (
    (envelope IS NULL OR (octet_length(envelope) <= 131072 AND envelope_hash IS NOT NULL AND envelope_hash ~ '^[a-f0-9]{64}$'))
    AND (status <> 'sending' OR envelope IS NOT NULL)
  ),
  CONSTRAINT team_invite_deliveries_receipt_check CHECK (
    status <> 'accepted' OR (provider_message_id IS NOT NULL AND length(provider_message_id) BETWEEN 1 AND 256 AND accepted_at IS NOT NULL AND envelope IS NULL)
  ),
  CONSTRAINT team_invite_deliveries_invite_team_fkey
    FOREIGN KEY (invite_id, team_id) REFERENCES public.user_invites(id, team_id) ON DELETE CASCADE
);
CREATE INDEX team_invite_deliveries_recovery_idx ON public.team_invite_deliveries(status, next_attempt_at);
ALTER TABLE public.team_invite_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.team_invite_deliveries AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.team_invite_deliveries FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.team_invite_deliveries TO agsaas_app, service_role;
COMMENT ON TABLE public.team_invite_deliveries IS 'Internal invitation email intent and provider receipt. No automatic legacy resend; exact body/key replay only within the guarded window.';
