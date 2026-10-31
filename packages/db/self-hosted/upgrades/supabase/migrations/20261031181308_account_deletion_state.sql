-- Additive upgrade only. Apply before the corresponding application revision.
-- The bootstrap baseline remains immutable. Run this migration in a transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.users ADD COLUMN deletion_started_at timestamptz;
COMMENT ON COLUMN public.users.deletion_started_at IS
  'Backend-controlled, retry-only account deletion marker. A failed Auth HTTP request must never clear it.';

-- A browser-writable marker would defeat the membership-acquisition guard.
-- Fail closed on an unexpected installation instead of changing broad grants.
DO $$
BEGIN
  IF has_column_privilege('anon', 'public.users', 'deletion_started_at', 'UPDATE')
    OR has_column_privilege('authenticated', 'public.users', 'deletion_started_at', 'UPDATE') THEN
    RAISE EXCEPTION 'Account deletion marker must not be writable by browser roles';
  END IF;
END
$$;
