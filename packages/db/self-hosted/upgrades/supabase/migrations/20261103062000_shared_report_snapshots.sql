-- Existing links keep their historical live behavior and are labeled explicitly.
ALTER TABLE public.reports
  ADD COLUMN mode text NOT NULL DEFAULT 'live',
  ADD COLUMN revenue_type text NOT NULL DEFAULT 'net',
  ADD COLUMN forecast_months integer NOT NULL DEFAULT 6,
  ADD COLUMN chart_snapshot jsonb,
  ADD COLUMN snapshot_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT reports_mode_check CHECK (mode IN ('live','snapshot')),
  ADD CONSTRAINT reports_revenue_type_check CHECK (revenue_type IN ('net','gross')),
  ADD CONSTRAINT reports_forecast_months_check CHECK (forecast_months BETWEEN 1 AND 24),
  ADD CONSTRAINT reports_snapshot_check CHECK ((mode<>'snapshot' OR (chart_snapshot IS NOT NULL AND chart_snapshot->>'version'='1' AND snapshot_at IS NOT NULL)) IS TRUE);
CREATE FUNCTION public.guard_shared_report_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.mode='snapshot' AND
    (NEW.team_id,NEW.link_id,NEW.type,NEW."from",NEW."to",NEW.currency,NEW.revenue_type,NEW.forecast_months,NEW.mode,NEW.chart_snapshot,NEW.snapshot_at)
    IS DISTINCT FROM
    (OLD.team_id,OLD.link_id,OLD.type,OLD."from",OLD."to",OLD.currency,OLD.revenue_type,OLD.forecast_months,OLD.mode,OLD.chart_snapshot,OLD.snapshot_at)
  THEN RAISE EXCEPTION 'Shared report snapshot and filters are immutable'; END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
  THEN RAISE EXCEPTION 'A revoked public report cannot be reopened'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_report_snapshot BEFORE UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION public.guard_shared_report_snapshot();
