-- Apply atomically after the previous incremental upgrades. Do not rewrite the
-- bootstrap baseline. The team owns its OAuth client; the user is only its author.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.oauth_applications IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  author_column smallint;
  author_not_null boolean;
  user_id_column smallint;
  actual pg_catalog.pg_constraint%ROWTYPE;
BEGIN
  SELECT attnum INTO STRICT user_id_column
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.users'::regclass
      AND attname = 'id' AND NOT attisdropped;
  SELECT attnum, attnotnull INTO STRICT author_column, author_not_null
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.oauth_applications'::regclass
      AND attname = 'created_by' AND NOT attisdropped;
  SELECT * INTO actual FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.oauth_applications'::regclass
      AND conname = 'oauth_applications_created_by_fkey';

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
    OR author_not_null IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Unexpected author FK definition: oauth_applications.oauth_applications_created_by_fkey';
  END IF;
END
$$;

ALTER TABLE public.oauth_applications
  DROP CONSTRAINT oauth_applications_created_by_fkey,
  ADD CONSTRAINT oauth_applications_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- Team/application deletion and each token/code's user_id CASCADE are unchanged.
-- No owner reassignment, token rotation, new grants, RLS, or Auth changes.
