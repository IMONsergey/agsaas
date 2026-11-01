-- Additive migration created with Supabase CLI 2.84.6. Only new browser
-- handshakes receive an intent; legacy encrypted states are not accepted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.inbox_oauth_intents') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected existing inbox OAuth intent schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agsaas_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb) THEN
    RAISE EXCEPTION 'Dedicated nonprivileged agsaas_app role is required';
  END IF;
END $$;

CREATE TABLE public.inbox_oauth_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  state_hash text NOT NULL,
  browser_nonce_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source text NOT NULL,
  aal text NOT NULL,
  redirect_path text,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT inbox_oauth_intents_state_key UNIQUE(state_hash),
  CONSTRAINT inbox_oauth_intents_hash_check CHECK (state_hash ~ '^[a-f0-9]{64}$' AND browser_nonce_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT inbox_oauth_intents_provider_check CHECK (provider IN ('gmail', 'outlook')),
  CONSTRAINT inbox_oauth_intents_source_check CHECK (source IN ('inbox', 'apps')),
  CONSTRAINT inbox_oauth_intents_aal_check CHECK (aal IN ('aal1', 'aal2')),
  CONSTRAINT inbox_oauth_intents_lifetime_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT inbox_oauth_intents_redirect_check CHECK (redirect_path IS NULL OR length(redirect_path) <= 2048)
);
CREATE INDEX inbox_oauth_intents_actor_expiry_idx ON public.inbox_oauth_intents(user_id, expires_at);
ALTER TABLE public.inbox_oauth_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.inbox_oauth_intents AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.inbox_oauth_intents FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inbox_oauth_intents TO agsaas_app, service_role;
COMMENT ON TABLE public.inbox_oauth_intents IS 'Backend-only 10 minute actor/team/provider intent; state and HttpOnly browser nonce are hashed separately. Callback consumes atomically before provider exchange.';
