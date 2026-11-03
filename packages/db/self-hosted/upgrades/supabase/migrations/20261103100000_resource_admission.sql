SET LOCAL lock_timeout = '5s';
CREATE TABLE public.request_resource_budgets (
  bucket text PRIMARY KEY CHECK (bucket ~ '^(user|team):[0-9a-f-]{36}$'),
  window_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0 AND used <= 100000)
);
CREATE INDEX request_resource_budgets_window_idx ON public.request_resource_budgets(window_start);
ALTER TABLE public.request_resource_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.request_resource_budgets TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.request_resource_budgets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_resource_budgets TO agsaas_app, service_role;

CREATE TABLE public.heavy_job_admissions (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL,
  user_id uuid,
  owner_run_id uuid NOT NULL,
  job_hash text NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX heavy_job_admissions_team_idx ON public.heavy_job_admissions(team_id);
CREATE TABLE public.resource_admission_reconciliations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_run_id uuid NOT NULL,
  evidence_reference text NOT NULL,
  released_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.heavy_job_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_admission_reconciliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.heavy_job_admissions TO agsaas_app USING (true) WITH CHECK (true);
CREATE POLICY agsaas_read ON public.resource_admission_reconciliations FOR SELECT TO agsaas_app USING (true);
CREATE POLICY agsaas_append ON public.resource_admission_reconciliations FOR INSERT TO agsaas_app WITH CHECK (true);
REVOKE ALL ON public.heavy_job_admissions, public.resource_admission_reconciliations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.heavy_job_admissions TO agsaas_app, service_role;
GRANT SELECT, INSERT ON public.resource_admission_reconciliations TO agsaas_app, service_role;
GRANT USAGE ON SEQUENCE public.resource_admission_reconciliations_id_seq TO agsaas_app, service_role;
COMMENT ON TABLE public.heavy_job_admissions IS 'No expiry. Release only after work settles, or after an operator confirms this worker process has stopped. Never recycle an uncertain active resource ticket automatically.';
