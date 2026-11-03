SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.integration_oauth_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  browser_nonce_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('xero','quickbooks','fortnox','slack','stripe')),
  source text NOT NULL CHECK (source IN ('apps','invoice-settings')),
  aal text NOT NULL CHECK (aal IN ('aal1','aal2')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  completed_at timestamptz,
  CHECK (state_hash ~ '^[a-f0-9]{64}$' AND browser_nonce_hash ~ '^[a-f0-9]{64}$'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (completed_at IS NULL OR consumed_at IS NOT NULL)
);
CREATE INDEX integration_oauth_intents_actor_expiry_idx ON public.integration_oauth_intents(user_id, expires_at);
ALTER TABLE public.integration_oauth_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.integration_oauth_intents FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.integration_oauth_intents FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_oauth_intents TO agsaas_app, service_role;
COMMENT ON TABLE public.integration_oauth_intents IS 'Backend-only ten-minute owner/team/provider OAuth handshake with hashed browser binding and atomic one-time consume and completion.';
