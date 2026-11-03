-- No historical invoices are sent or scheduled by this migration.
-- Manual issuance/schedules commit SQL intents using the existing immutable outbox.
-- Email handoff also survives loss of Redis after PDF generation.
ALTER TABLE public.financial_job_dispatches
  DROP CONSTRAINT financial_job_dispatches_queue_check;
ALTER TABLE public.financial_job_dispatches
  ADD CONSTRAINT financial_job_dispatches_queue_check CHECK (
    (job_name, queue_name) IN (
      ('generate-invoice', 'invoices'),
      ('send-invoice-email', 'invoices'),
      ('enrich-transactions', 'transactions'),
      ('match-transactions-bidirectional', 'inbox'),
      ('notification', 'notifications')
    )
  );
