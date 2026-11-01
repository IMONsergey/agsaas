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

## Team financial-history retention (packet 02)

`20261101042940_preserve_team_financial_history.sql` changes only the historical
author foreign keys of `apps`, `bank_accounts`, `invoice_recurring` and
`invoices` from `CASCADE` to `SET NULL`. The bank-account and recurring-series
author columns become nullable. Existing records are not recalculated,
reassigned to another employee, or backfilled. Deletion of the owning **team**
continues to cascade normally. Personal keys, memberships and identity links
retain their deletion behavior.

Deploy the nullable-author-compatible application before allowing account
deletions on the upgraded schema; treat migration and application deployment as
one gated maintenance operation. Old recurring workers reject a null creator.
Stop account-deletion and invoice workers for the maintenance window, apply
upgrades in timestamp order with `psql --single-transaction --set=ON_ERROR_STOP=1`
or the reviewed migration runner, deploy the application, and then resume
workers. The SQL explicitly locks the parent and four child tables to keep its
schema preflight and replacement atomic. A five-second lock timeout and
30-second statement timeout fail closed: retry during a quieter maintenance
window, not by removing these limits blindly. Constraint validation can scan
large tables; rehearse against a disposable copy sized like the target first.

The preflight expects the exact original validated `CASCADE` constraints and
column nullability. Do not use this migration as a generic schema repair, or
reapply it to a database on which it is already recorded. Do not roll back the
new `SET NULL` author columns to `NOT NULL` after an author has been deleted;
that requires a separately reviewed data policy, not invented replacement
authors.

The database regression tests exercise PostgreSQL deletion and these exact SQL
statements. They do not by themselves prove the deployed Supabase Auth HTTP
flow, its JWT lifecycle, or Storage cleanup. Those require a matched-stack
staging rehearsal before production rollout. A recurring generation already
holding a pre-deletion author snapshot can fail its foreign key check and
retry with fresh data; the series itself is preserved.

Explicit follow-ups outside this migration: third-party grant revocation or
reconnection, retention of team OAuth application definitions, and policy for
author-owned report/share links. Report links retain existing revocation
behavior; their underlying financial transactions are not deleted by those
report-link cascades. Retaining an integration row does not guarantee that an
external provider credential remains valid, nor does it anonymize arbitrary
provider settings JSON.
