-- Apply in one transaction, after account_deletion_state and before the new
-- application revision. The bootstrap baseline is immutable.
-- Historical authorship is nullable; company ownership and team cascades stay.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Stable parent-then-child lock order closes the preflight/DDL race. These are
-- bounded maintenance locks, not locks held during any external HTTP request.
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.apps, public.bank_accounts, public.invoice_recurring, public.invoices
  IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  expected record;
  author_column smallint;
  author_not_null boolean;
  user_id_column smallint;
  actual pg_catalog.pg_constraint%ROWTYPE;
BEGIN
  SELECT attnum INTO STRICT user_id_column
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.users'::regclass AND attname = 'id' AND NOT attisdropped;

  FOR expected IN
    SELECT * FROM (VALUES
      ('apps', 'created_by', 'apps_created_by_fkey', false),
      ('bank_accounts', 'created_by', 'bank_accounts_created_by_fkey', true),
      ('invoice_recurring', 'user_id', 'invoice_recurring_user_id_fkey', true),
      ('invoices', 'user_id', 'invoices_created_by_fkey', false)
    ) AS expected_keys(table_name, column_name, constraint_name, was_not_null)
  LOOP
    SELECT attnum, attnotnull INTO STRICT author_column, author_not_null
      FROM pg_catalog.pg_attribute
      WHERE attrelid = format('public.%I', expected.table_name)::regclass
        AND attname = expected.column_name AND NOT attisdropped;

    SELECT * INTO actual FROM pg_catalog.pg_constraint
      WHERE conrelid = format('public.%I', expected.table_name)::regclass
        AND conname = expected.constraint_name;

    IF NOT FOUND
      OR actual.contype IS DISTINCT FROM 'f'
      OR actual.confrelid IS DISTINCT FROM 'public.users'::regclass
      OR actual.conkey IS DISTINCT FROM ARRAY[author_column]::smallint[]
      OR actual.confkey IS DISTINCT FROM ARRAY[user_id_column]::smallint[]
      OR actual.confdeltype IS DISTINCT FROM 'c'
      OR actual.confupdtype IS DISTINCT FROM 'a'
      OR actual.confmatchtype IS DISTINCT FROM 's'
      OR actual.convalidated IS DISTINCT FROM true
      OR actual.condeferrable IS DISTINCT FROM false
      OR author_not_null IS DISTINCT FROM expected.was_not_null THEN
      RAISE EXCEPTION 'Unexpected author FK definition: %.%', expected.table_name, expected.constraint_name;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE public.bank_accounts ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.invoice_recurring ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.apps
  DROP CONSTRAINT apps_created_by_fkey,
  ADD CONSTRAINT apps_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.bank_accounts
  DROP CONSTRAINT bank_accounts_created_by_fkey,
  ADD CONSTRAINT bank_accounts_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.invoice_recurring
  DROP CONSTRAINT invoice_recurring_user_id_fkey,
  ADD CONSTRAINT invoice_recurring_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.invoices
  DROP CONSTRAINT invoices_created_by_fkey,
  ADD CONSTRAINT invoices_created_by_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
