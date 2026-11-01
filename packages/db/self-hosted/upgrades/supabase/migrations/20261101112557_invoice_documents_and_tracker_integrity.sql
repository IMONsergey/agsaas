-- Incremental, transactional; ambiguous legacy history is preserved for explicit review.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.invoices, public.tracker_entries IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices WHERE invoice_number IS NOT NULL
    GROUP BY team_id, btrim(invoice_number) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate invoice numbers require explicit reconciliation before this upgrade';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tracker_entries WHERE stop IS NULL AND start IS NOT NULL AND assigned_id IS NOT NULL
    GROUP BY team_id, assigned_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Multiple running timers require explicit reconciliation before this upgrade';
  END IF;
  IF to_regclass('public.invoice_number_counters') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected existing invoice number allocator';
  END IF;
END $$;

ALTER TABLE public.invoices ADD COLUMN document_snapshot jsonb;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_document_snapshot_shape CHECK (
  document_snapshot IS NULL OR (jsonb_typeof(document_snapshot) = 'object' AND document_snapshot->'version' = '1'::jsonb
    AND jsonb_typeof(document_snapshot->'document') = 'object' AND document_snapshot->>'source' IN ('issued','generation','legacy_current')) IS TRUE
);
CREATE UNIQUE INDEX invoices_team_number_key ON public.invoices(team_id, btrim(invoice_number));
CREATE TABLE public.invoice_number_counters (
  team_id uuid PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,
  last_number numeric NOT NULL CHECK (last_number >= 0 AND last_number = trunc(last_number))
);
INSERT INTO public.invoice_number_counters(team_id, last_number)
SELECT team_id, COALESCE(MAX(CASE WHEN length(SUBSTRING(btrim(invoice_number) FROM '[0-9]+$')) <= 100 THEN SUBSTRING(btrim(invoice_number) FROM '[0-9]+$')::numeric END), 0)
FROM public.invoices GROUP BY team_id;
ALTER TABLE public.invoice_number_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.invoice_number_counters AS PERMISSIVE FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.invoice_number_counters FROM PUBLIC, anon, authenticated, service_role, agsaas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_number_counters TO agsaas_app, service_role;

CREATE FUNCTION public.capture_invoice_document(invoice_row public.invoices, capture_source text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $capture$
  SELECT jsonb_build_object('version', 1, 'source', capture_source, 'capturedAt', now(),
    'document', jsonb_build_object(
      'invoiceNumber', invoice_row.invoice_number,
      'issueDate', invoice_row.issue_date,
      'dueDate', invoice_row.due_date,
      'amount', invoice_row.amount,
      'currency', invoice_row.currency,
      'lineItems', invoice_row.line_items,
      'paymentDetails', invoice_row.payment_details,
      'customerDetails', invoice_row.customer_details,
      'fromDetails', invoice_row.from_details,
      'noteDetails', invoice_row.note_details,
      'customerName', invoice_row.customer_name,
      'customerId', invoice_row.customer_id,
      'discount', invoice_row.discount,
      'subtotal', invoice_row.subtotal,
      'vat', invoice_row.vat,
      'tax', invoice_row.tax,
      'topBlock', invoice_row.top_block,
      'bottomBlock', invoice_row.bottom_block,
      'template', invoice_row.template
    ));
$capture$;

-- This is the currently stored legacy document, not a claim about previously sent bytes.
UPDATE public.invoices SET document_snapshot = public.capture_invoice_document(invoices, 'legacy_current')
WHERE status IN ('unpaid','overdue','paid','refunded','canceled') OR paid_at IS NOT NULL OR refunded_at IS NOT NULL;

CREATE FUNCTION public.guard_invoice_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.document_snapshot IS NOT NULL THEN
    IF NEW.document_snapshot IS DISTINCT FROM OLD.document_snapshot
      OR ROW(NEW.invoice_number, NEW.amount, NEW.currency, NEW.subtotal, NEW.vat, NEW.tax, NEW.discount, NEW.line_items, NEW.customer_id, NEW.customer_name, NEW.customer_details, NEW.from_details, NEW.token) IS DISTINCT FROM ROW(OLD.invoice_number, OLD.amount, OLD.currency, OLD.subtotal, OLD.vat, OLD.tax, OLD.discount, OLD.line_items, OLD.customer_id, OLD.customer_name, OLD.customer_details, OLD.from_details, OLD.token) THEN
      RAISE EXCEPTION 'Issued invoice is immutable. Duplicate it to create a corrected invoice.' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.document_snapshot IS NULL AND NEW.status IN ('unpaid','overdue','paid','refunded') THEN
    NEW.document_snapshot := public.capture_invoice_document(NEW, 'issued');
  END IF;
  IF NEW.document_snapshot IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.document_snapshot IS NULL) AND (
      NEW.document_snapshot->'document'->'invoiceNumber' IS DISTINCT FROM COALESCE(to_jsonb(NEW.invoice_number), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'amount' IS DISTINCT FROM COALESCE(to_jsonb(NEW.amount), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'currency' IS DISTINCT FROM COALESCE(to_jsonb(NEW.currency), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'subtotal' IS DISTINCT FROM COALESCE(to_jsonb(NEW.subtotal), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'discount' IS DISTINCT FROM COALESCE(to_jsonb(NEW.discount), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'vat' IS DISTINCT FROM COALESCE(to_jsonb(NEW.vat), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'tax' IS DISTINCT FROM COALESCE(to_jsonb(NEW.tax), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'customerId' IS DISTINCT FROM COALESCE(to_jsonb(NEW.customer_id), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'customerName' IS DISTINCT FROM COALESCE(to_jsonb(NEW.customer_name), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'customerDetails' IS DISTINCT FROM COALESCE(to_jsonb(NEW.customer_details), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'fromDetails' IS DISTINCT FROM COALESCE(to_jsonb(NEW.from_details), 'null'::jsonb)
      OR NEW.document_snapshot->'document'->'lineItems' IS DISTINCT FROM COALESCE(to_jsonb(NEW.line_items), 'null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'Invoice snapshot does not match its financial identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER invoices_document_guard BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_document();

ALTER TABLE public.tracker_entries ADD COLUMN billing_snapshot_source text;
-- Preserve existing snapshots. Missing historical prices use current project terms,
-- explicitly labelled legacy_current; no claim of reconstructed historical rates.
UPDATE public.tracker_entries entry SET
  rate = COALESCE(entry.rate, CASE WHEN project.billable THEN COALESCE(project.rate, 0) ELSE 0 END),
  currency = upper(COALESCE(entry.currency, project.currency, team.base_currency, 'USD')),
  billing_snapshot_source = 'legacy_current'
FROM public.tracker_projects project, public.teams team
WHERE entry.project_id = project.id AND entry.team_id = project.team_id AND team.id = entry.team_id;
UPDATE public.tracker_entries SET billing_snapshot_source = 'legacy_current' WHERE billing_snapshot_source IS NULL;
CREATE UNIQUE INDEX tracker_entries_one_running_timer ON public.tracker_entries(team_id, assigned_id)
WHERE stop IS NULL AND start IS NOT NULL AND assigned_id IS NOT NULL;
COMMENT ON COLUMN public.invoices.document_snapshot IS 'Immutable printable document captured on issue/generation; legacy_current means the state available at upgrade, not reconstructed sent history.';
COMMENT ON COLUMN public.tracker_entries.billing_snapshot_source IS 'recorded: terms captured on entry; legacy_current: best available terms at upgrade, historical terms not reconstructed.';

CREATE OR REPLACE FUNCTION public.get_project_total_amount(project public.tracker_projects)
RETURNS numeric LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT CASE WHEN bool_or(upper(COALESCE(entry.currency, project.currency, 'USD')) <> upper(COALESCE(project.currency, 'USD')))
    THEN NULL ELSE COALESCE(sum(entry.duration / 3600.0 * COALESCE(entry.rate, project.rate, 0)), 0) END
  FROM public.tracker_entries entry WHERE entry.project_id = project.id AND entry.team_id = project.team_id;
$function$;

-- Capture terms at the DB boundary as well, including direct approved application writers.
CREATE FUNCTION public.capture_tracker_billing() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $billing$
DECLARE terms record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
    NEW.rate := OLD.rate;
    NEW.currency := OLD.currency;
    NEW.billing_snapshot_source := OLD.billing_snapshot_source;
    RETURN NEW;
  END IF;
  IF NEW.project_id IS NULL THEN
    NEW.rate := 0;
    NEW.billing_snapshot_source := 'recorded';
    RETURN NEW;
  END IF;
  SELECT CASE WHEN project.billable THEN COALESCE(project.rate, 0) ELSE 0 END AS rate,
    upper(COALESCE(project.currency, team.base_currency, 'USD')) AS currency INTO terms
  FROM public.tracker_projects project JOIN public.teams team ON team.id = project.team_id
  WHERE project.id = NEW.project_id AND project.team_id = NEW.team_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tracker project does not belong to this team' USING ERRCODE = '23514'; END IF;
  NEW.rate := terms.rate;
  NEW.currency := terms.currency;
  NEW.billing_snapshot_source := 'recorded';
  RETURN NEW;
END;
$billing$;
CREATE TRIGGER tracker_entries_billing_snapshot BEFORE INSERT OR UPDATE ON public.tracker_entries
FOR EACH ROW EXECUTE FUNCTION public.capture_tracker_billing();
