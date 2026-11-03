CREATE TABLE public.export_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK ((jsonb_typeof(snapshot)='object' AND snapshot->>'teamId'=team_id::text AND snapshot->>'version'='1') IS TRUE),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(team_id,operation_key)
);
ALTER TABLE public.export_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.export_snapshots FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.export_snapshots TO agsaas_app;
CREATE POLICY agsaas_backend ON public.export_snapshots FOR ALL TO agsaas_app USING(true) WITH CHECK(true);
CREATE FUNCTION public.guard_export_snapshot_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF (NEW.id,NEW.team_id,NEW.operation_key,NEW.request_hash,NEW.snapshot,NEW.snapshot_hash,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.team_id,OLD.operation_key,OLD.request_hash,OLD.snapshot,OLD.snapshot_hash,OLD.created_at)
  THEN RAISE EXCEPTION 'Export snapshot identity and data are immutable'; END IF;
  IF OLD.result->>'status'='complete' AND NEW.result IS DISTINCT FROM OLD.result
  THEN RAISE EXCEPTION 'A completed export receipt is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_snapshot_identity BEFORE UPDATE ON public.export_snapshots FOR EACH ROW EXECUTE FUNCTION public.guard_export_snapshot_identity();
