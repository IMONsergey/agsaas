CREATE TABLE IF NOT EXISTS public.support_requests (
 id uuid PRIMARY KEY,
 source text NOT NULL CHECK (source IN ('website','dashboard')),
 scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 128),
 payload_hash text NOT NULL CHECK (length(payload_hash)=64),
 team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
 user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
 email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
 full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
 priority text NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
 product text NOT NULL CHECK (length(product) BETWEEN 1 AND 50),
 message text NOT NULL CHECK (length(message) BETWEEN 1 AND 10000),
 status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','resolved')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_requests_scope_created ON public.support_requests(scope_key,created_at);
CREATE INDEX IF NOT EXISTS support_requests_team_user ON public.support_requests(team_id,user_id,created_at);
ALTER TABLE public.support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_requests FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agsaas_app') THEN
   GRANT SELECT, INSERT, UPDATE ON public.support_requests TO agsaas_app;
   IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_requests' AND policyname='support_backend') THEN
     CREATE POLICY support_backend ON public.support_requests FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
   END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   GRANT SELECT, INSERT, UPDATE ON public.support_requests TO service_role;
 END IF;
END $$;
