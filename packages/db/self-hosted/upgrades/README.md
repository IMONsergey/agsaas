# Incremental self-hosted upgrades

These migrations are separate from the immutable bootstrap baseline. The
`self-hosted-db.mts` bootstrap helper intentionally refuses extra baseline
migrations; do not rewrite or re-run the baseline to upgrade an existing DB.

Apply reviewed upgrades in timestamp order, in a transaction, after taking a
backup and validating them on a disposable copy of the matched Supabase stack.
Record the applied SQL in `supabase_migrations.schema_migrations`. Never run
Drizzle `push` or the disposable test setup against a deployed application DB.

The account-deletion upgrade adds a nullable, backend-controlled marker to the
existing user profile. It does not delete or backfill user data, add browser
write grants, or change the immutable Auth bridge. Deploy the migration before
the application version that queries the new column. Do not roll back to an old
application while any deletion marker remains: old membership writers do not
understand the pending-deletion state.

An Auth transport timeout is not proof of cancellation. Pending deletion is
retry-only; never clear the marker merely because the client request failed.
The dashboard offers recovery outside the active-team layout. Shared-team
ownership must be transferred before preparation begins. External provider
cleanup, retention policy and durable cleanup-job delivery remain separate
release gates.
