-- Additive migration created with Supabase CLI 2.84.6. Apply transactionally.
-- Historical Polar subscription IDs/versions cannot be inferred from a plan.
-- Leave them NULL; only a verified active/trialing event can establish a binding.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.teams
  ADD COLUMN billing_subscription_id text,
  ADD COLUMN billing_subscription_created_at timestamptz,
  ADD COLUMN billing_updated_at timestamptz;

COMMENT ON COLUMN public.teams.billing_subscription_id IS
  'Last SDK-verified own-product Polar subscription ID, retained after revocation to reject stale events. Never inferred from email.';
COMMENT ON COLUMN public.teams.billing_updated_at IS
  'Polar subscription resource modifiedAt version; NULL legacy state is unbound, not a guessed local timestamp.';
COMMENT ON COLUMN public.teams.billing_subscription_created_at IS
  'Immutable Polar subscription resource createdAt; orders different subscriptions independently of their modification clocks.';
