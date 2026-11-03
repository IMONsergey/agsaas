
CREATE TABLE IF NOT EXISTS public.customer_enrichment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  is_current boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'queued',
  attempt_id uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  CONSTRAINT customer_enrichment_operation_status CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  CONSTRAINT customer_enrichment_operation_attempts CHECK (attempt_count BETWEEN 0 AND 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_enrichment_one_current
  ON public.customer_enrichment_operations(customer_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS customer_enrichment_pending
  ON public.customer_enrichment_operations(next_attempt_at, requested_at)
  WHERE is_current AND status IN ('queued','processing');
ALTER TABLE public.customer_enrichment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_enrichment_operations FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public.customer_enrichment_operations FROM %I',role_name);
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['agsaas_app','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_enrichment_operations TO %I',role_name);
    END IF;
  END LOOP;
END $$;
-- agsaas_app owns its application tables on this installation; explicit policy
-- keeps a fresh non-owner application role usable without exposing browser access.
DROP POLICY IF EXISTS customer_enrichment_backend ON public.customer_enrichment_operations;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agsaas_app') THEN
    CREATE POLICY customer_enrichment_backend ON public.customer_enrichment_operations
      FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Legacy unversioned work cannot safely be replayed; a user may request a fresh operation.
UPDATE public.customers c SET enrichment_status='failed' WHERE enrichment_status IN ('pending','processing') AND NOT EXISTS (SELECT 1 FROM public.customer_enrichment_operations o WHERE o.customer_id=c.id AND o.is_current);
