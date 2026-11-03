SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE public.security_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  team_id uuid,
  actor_user_id uuid,
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z_]{1,32}$'),
  target_id text NOT NULL CHECK (target_id ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384),
  CHECK (team_id IS NOT NULL OR actor_user_id IS NOT NULL)
);
CREATE INDEX security_audit_events_team_id_idx ON public.security_audit_events(team_id, id DESC);
CREATE INDEX security_audit_events_actor_global_idx ON public.security_audit_events(actor_user_id, id DESC) WHERE team_id IS NULL;
ALTER TABLE public.security_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_read ON public.security_audit_events FOR SELECT TO agsaas_app USING (true);
CREATE POLICY agsaas_append ON public.security_audit_events FOR INSERT TO agsaas_app WITH CHECK (true);
REVOKE ALL ON public.security_audit_events FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT ON public.security_audit_events TO agsaas_app, service_role;
REVOKE ALL ON SEQUENCE public.security_audit_events_id_seq FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT USAGE ON SEQUENCE public.security_audit_events_id_seq TO agsaas_app, service_role;
COMMENT ON TABLE public.security_audit_events IS 'Append-only application security history. No credential or free-text payloads. UUID actor/team identifiers remain for operational attribution after deletion; controlled maintenance owns retention, ordinary application roles cannot erase or rewrite events.';
