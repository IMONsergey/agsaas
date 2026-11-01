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
reconnection and policy for
author-owned report/share links. Report links retain existing revocation
behavior; their underlying financial transactions are not deleted by those
report-link cascades. Retaining an integration row does not guarantee that an
external provider credential remains valid, nor does it anonymize arbitrary
provider settings JSON.

## Durable payments, email and team OAuth (packet 03)

Apply all three migrations in order, before starting the corresponding API or
worker revision:

1. `20261101060329_preserve_team_oauth_applications.sql` changes only the
   application creator FK to `SET NULL`. Team ownership and personal grant
   revocation remain distinct. Retained client secrets may still be known to a
   departed creator; secret rotation is an explicit operational decision.
2. `20261101060354_reserve_invoice_payments.sql` creates the backend-only
   reservation table and the unique invoice/team key. Existing payment intents
   are validated and adopted through the normal application path, not blindly
   backfilled by migration. Old checkout writers must not run concurrently with
   the new reservation writer.
3. `20261101060507_durable_invoice_email_delivery.sql` creates the backend-only
   immutable delivery journal. It depends on the preceding composite key.
   Existing Redis jobs have no retroactive provider receipt. Drain or reconcile
   old in-flight jobs before switching workers; do not empty queues blindly.

Both new tables contain private financial or email metadata. Verify RLS and
the absence of grants for `PUBLIC`, `anon` and `authenticated`, using actual
effective privileges, not only policy names. A freshly initialized Supabase
database has default grants: a successful `pg_restore` is not sufficient proof
that the restored object ACLs match the source. The dedicated rehearsal helper
normalizes target defaults before restore and compares canonical permissions
afterward. Do not weaken the account-deletion migration's browser-write guard
to get past a restore mismatch.

Do not roll application code back while payment reservations or unfinished
delivery operations exist. Old code does not understand their locks, receipts
or retry boundaries. Keep writes stopped until an explicitly reviewed forward
fix or reconciliation is ready. Provider idempotency windows are finite;
changing a key or resetting first-attempt timestamps is not a recovery plan.

See [invoice email operations](../../../../docs/agsaas-invoice-email-delivery.md)
and the [packet 03 report](../../../../docs/agsaas-hardening-packet-03.md).

## Durable team invitations (packet 04)

`20261101080254_durable_team_invitation_delivery.sql` adds the backend-only
invitation delivery journal and composite invitation/team foreign key. Apply
it transactionally after packet 03 and before deploying the new invitation
API and workers. The file was created with Supabase CLI 2.84.6. It deliberately
does not backfill existing invitations or infer a provider receipt from old
Trigger.dev jobs. Reconcile pre-switch tasks separately; automatic recovery
only scans intents explicitly created by the new application transaction.

See [team invitation delivery](../../../../docs/agsaas-team-invitation-delivery.md)
for configuration, queued/accepted semantics and finite replay boundaries.
