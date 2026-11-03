# Recovering an export result

The full-team export card now includes recent saved export receipts. This is a
read-only recovery view for an existing export. It does not enqueue, retry,
cancel or import an archive.

## When the progress read fails

A transport or authorization error while reading a job is not evidence that the
job failed. The progress view keeps the same job ID and leaves the export button
busy. **Check status** repeats the existing status read. A returned `unknown`
state also keeps that handle; it does not become a success or failure.

A positively observed terminal `failed` state ends that progress view. A
completed archive still has its separate completeness outcome. An incomplete
archive remains explicitly incomplete.

The browser's progress handle is not persisted by this change. After a reload,
or after Redis no longer retains the job, use **Recent team exports** to recover
a durable archive receipt. Jobs that have not yet saved a SQL snapshot cannot
appear there. An unrelated history record is not presented as proof about a
particular missing Redis job.

## Reading history and downloading

The history endpoints use the same current-session, primary membership and MFA
boundary as `team.exportAllData`. The database query reads the primary, fixes
the tenant from authenticated context and selects only full-team exports.
Pagination is bounded and preserves PostgreSQL timestamp microseconds.

The response includes selected IDs, timestamps, completeness counts and hashes.
It never includes the business snapshot, transaction rows, credentials, raw
receipt objects, provider errors or a signed URL. Download filenames are derived
on the server. An archive path must match the exact team, operation, snapshot and
content hash in its saved receipt. History and the archive access boundary share
`validateExportArchiveReceipt`.

A missing receipt means **outcome not yet confirmed**. A malformed or mismatched
receipt has no download. Partial and failed receipts can expose an explicitly
incomplete or diagnostic archive; they are never shown as a complete export.
A recorded complete outcome does not assert that Storage still contains the
file today.

Before each download the UI performs a fresh protected receipt GET. It compares
the result with the displayed receipt, then rechecks the current account, team
and session-bound file capability. A team/session change while that read is in
flight cancels the action. A current query error hides stale history actions.
The existing authenticated file endpoint remains the final access check.
Download/save errors are awaited and displayed with a generic message.

## Acceptance boundaries

This feature does not implement business import or disaster recovery.
The portable export deliberately excludes credentials and cannot silently
recreate authentication identities, encrypted-field keys or live integrations.
The separate cold backup contract remains in
`deploy/self-hosted/BACKUP-RECOVERY.md`.

Prepared focused suites:

- `apps/dashboard/src/components/export-status.test.tsx`: actual progress and
  export-button logic through passive-hook and IO adapters; run in its own
  fresh Bun process.
- `packages/db/src/export-history.test.ts`: whitelist, unknown outcomes and
  cursor metadata, using the shared archive receipt validator.
- `packages/db/src/test/export-history-postgres.test.ts`: five isolated PG
  cases for tenant/kind separation, primary routing, enforced read-only access,
  exact pagination and distinct receipt outcomes. It requires the guarded
  synthetic database and existing export snapshot schema; it creates no DDL.
- `apps/api/src/__tests__/trpc/export-history.test.ts`: actual protected router,
  current membership, strict inputs and absence of queue mutation; use the
  existing API test setup in a fresh process.
- `apps/dashboard/src/components/export-history.test.tsx`: actual server-rendered
  component and captured read/download handlers, including stale cache,
  team/session changes, diagnostic archives and asynchronous save failure.

Source review and formatting are separate from runtime acceptance. Execute
these suites only through the coordinated shared job queue against the exact
reviewed source and dependencies.