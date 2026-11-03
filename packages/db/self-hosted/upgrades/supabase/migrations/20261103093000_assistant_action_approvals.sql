SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE public.assistant_action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  tool_name text NOT NULL CHECK (tool_name IN ('invoices_send','invoices_delete')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object' AND octet_length(preview::text) <= 16384),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','rejected','expired','stale')),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096)),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((status = 'pending' AND completed_at IS NULL) OR status <> 'pending')
);
CREATE INDEX assistant_action_approvals_actor_pending_idx ON public.assistant_action_approvals(user_id, team_id, session_id, expires_at) WHERE status = 'pending';
ALTER TABLE public.assistant_action_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.assistant_action_approvals FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.assistant_action_approvals FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_action_approvals TO agsaas_app, service_role;
COMMENT ON TABLE public.assistant_action_approvals IS 'Backend-only manual assistant approvals bound to actor, current browser session, tenant, immutable invoice/recipient revision and ten-minute expiry. Chat history cannot approve.';
