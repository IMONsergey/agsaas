# Reviewed synthetic foundation for the existing PG16 test fixture

This helper is a **test fixture operation**, not the production installer. It is
limited to the previously inspected PostgreSQL 16.15 instance, system identifier
`7703819082990792743`, database `midday_test`, reached through a loopback host at
port `55439`. It does not run Supabase Auth, Storage, Realtime or PostgreSQL 17.
Passing the subsequent PostgreSQL suites does not establish canonical platform
acceptance or complete service readiness.

## Why the fixture needs a new foundation

The existing database has 62 public tables created by Drizzle and a few targeted
upgrades. There is no trustworthy record that the original SQL upgrades ran.
Their financial, invoice document and tracker guards are missing. Auth has two
constant test functions and no tables; the private membership function is a
constant empty set. Storage and the Realtime publication are absent. Table
existence is insufficient evidence of a migration.

The early SQL files deliberately reject existing tables. Applying them to this
catalog, claiming them as already applied, or extracting only their tails would
hide the problem. Instead, the reviewed operation preserves the old schemas and
creates a new, explicitly synthetic fixture. No existing table or row is deleted,
copied, truncated or rewritten by the helper.

## Exact scope

Within one transaction the helper:

1. Takes a database advisory lock and refuses any other connected client. It
   validates the known instance, the original 62-table shape, role privileges,
   absence of platform integrations, an operator approval marker and both the
   complete catalog and source fingerprints.
2. Locks all original tables with `ACCESS EXCLUSIVE NOWAIT` and repeats the
   fingerprint comparison. It renames `public`, `private` and `auth` to three
   unique names derived from the approved UUID. Their schema and table OIDs stay
   the same. Browser/application roles lose schema access to these archives.
   The archives remain in the database; the helper has no archive deletion path.
3. Moves the **existing relocatable** vector 0.8.7 and pg_trgm 1.6 extensions to
   `extensions`. Their OIDs and versions are verified afterwards; old table
   references keep their existing type OIDs. This relocation is confined to this
   reviewed synthetic operation. Production prerequisite checks remain unchanged.
4. Creates the minimal Auth/Storage SQL test catalogs from
   `synthetic-platform.sql`. The Auth subject and claims read the transaction's
   request GUC, rather than constant identities. Test roles use the actual
   application RLS/session/MFA policies. No real service migration is imitated.
5. Executes the complete immutable application baseline and every one of the 33
   sorted SQL upgrades. `synthetic-foundation-source-lock.json` records each
   filename and SHA256. It refuses changed, additional, missing or reordered
   SQL. The baseline already contains `before.sql` and `after.sql`; they are not
   applied a second time. The baseline also sets `agsaas_app`'s search path; its
   prior role settings are recorded in the receipt.
6. Checks the archive OIDs/storage identities, the required application tables
   and the extension identities. It records exact source receipts under
   `private.agsaas_synthetic_fixture_provenance`, denied to browser and application
   roles. It never creates `supabase_migrations` or canonical installation history.

Ordinary SQL failures roll the transaction back. The helper then re-reads the
catalog and reports whether its original fingerprint was restored. A connection
failure during COMMIT is explicitly reported as an unknown outcome: inspect the
private provenance before attempting anything else. Do not automatically retry.

## Review and execution

Only the root coordinator runs database work, through the existing shared
`/usr/local/bin/imon-job` queue. The helper independently checks its real systemd
cgroup for an `imon-job@...service` unit before permitting writes. It performs no
OS privilege escalation and does not change the queue, Docker or other services.

Run from the merged project containing all 33 upgrades, with the already guarded
`TEST_DATABASE_URL` loaded from the private test environment. Do not print that
file or put credentials in command arguments. Exact command arguments for the
read-only step are:

```text
bun --no-env-file packages/db/src/test/helpers/synthetic-foundation.mts --inspect
```

This prints an inspect report with `mutation: false`, the catalog fingerprint,
the source fingerprint and exact source receipts. It performs only catalog reads
inside `BEGIN READ ONLY` and `ROLLBACK`. It does not generate approval itself.

After reviewing that report, the coordinator writes a regular, current-user-owned
mode-0600 approval JSON file containing:

```json
{
  "kind": "agsaas-synthetic-foundation-v1",
  "mode": "rehearse",
  "operationId": "<new UUIDv4>",
  "database": "midday_test",
  "port": 55439,
  "systemId": "7703819082990792743",
  "catalogSha256": "<exact inspect catalogSha256>",
  "sourceSetSha256": "<exact inspect sourceSetSha256>",
  "acknowledgement": "preserve-old-schemas-and-create-synthetic-auth-storage-fixture-only",
  "preserveOldSchemas": true,
  "allowRelocatableExtensions": true,
  "acceptSyntheticPlatformOnly": true
}
```

The queued environment must also explicitly set
`AGSAAS_SYNTHETIC_FOUNDATION_WRITE` to the same acknowledgement string. First run:

```text
bun --no-env-file packages/db/src/test/helpers/synthetic-foundation.mts --rehearse --approval <private-approval-file>
```

Rehearsal executes the full operation, then causes an actual PostgreSQL `22P02`
error after the final upgrade and provenance insertion. It reports success only
if ROLLBACK restores the full original catalog fingerprint. This is a SQL atomicity
test, including extension placement, role settings and publication rollback.

Once that receipt has been reviewed, create a separately reviewed marker with
`"mode": "commit"` and invoke `--apply --approval <private-commit-approval-file>`
in the queue. A rehearsal marker cannot commit. The operation intentionally is
not replayable on its finished catalog: another run refuses the changed shape
and fingerprints. Keep the resulting provenance and the untouched archives.

## Source revision and existing fixture provenance

The source lock now contains the baseline plus 33 ordered upgrades, reviewed from
commit `7281e338c9d381b0054c31f40fd15b142566577e`. The previous 32 entries are unchanged.
The appended source files are `20261103110000_invoice_refund_requests.sql` and
`20261103111000_plaid_hosted_consent.sql`; their exact SHA256 values are in the lock.
This refresh describes the complete reviewed SQL for a prospective foundation.
It does not establish that either additional upgrade ran on an existing database.

The already completed fixture operation `0f191da4-bb92-4262-bcdb-2195cf109bcd`
executed the earlier baseline plus 31 upgrades. Its original source fingerprint
`343e96a887bd93aac9f0eec6c1d22a4873f01819ecefcbdff3d3af8071052ff3`, receipt and
`private.agsaas_synthetic_fixture_provenance` row remain unchanged. Do not re-run
this foundation helper on that completed catalog. The separately reviewed
synthetic append runner records later upgrades in a distinct append-only private
journal, after its own inspect and rollback rehearsal. Neither source-lock edits
nor append receipts fabricate canonical Supabase applied history.

A further SQL file requires an explicit reviewed lock append, updated exact
source-count assertions, and refreshed source fingerprints for any new approval.
Never accept a new file merely by loosening the directory/count/hash checks.

## Verification bounds and suite compatibility

The companion unit tests validate endpoint, mode, identity, fingerprint and SQL
source drift refusals, bounded archive identifiers and the actual merged
34-source lock. They do not connect to PostgreSQL. The queued rehearsal provides
the actual SQL failure/rollback evidence; the subsequent application suites
provide query, trigger, RLS and concurrency evidence. Neither substitutes for
the gated canonical Auth/Storage/PostgreSQL 17 rehearsal.

The real baseline creates application profiles when test Auth users are inserted.
Fixtures must seed Auth first and update only their own profile fields with
`ON CONFLICT (id)`. Storage fixture setup must tolerate the shared test catalogs.
Finance and security fixture commits cover these changes without disabling
production guards or relaxing assertions.

Legacy `test:e2e:setup` performs Drizzle push and must not be run on this new
foundation. The old incremental-upgrade suites perform rollback-scoped destructive
DDL to reconstruct earlier versions; run each separately after reviewing its
dependencies. The main application suites use their own fixture identities.
Do not run legacy shared-table TRUNCATE suites concurrently with them.

PostgreSQL documents that `ALTER EXTENSION ... SET SCHEMA` requires a relocatable
extension: https://www.postgresql.org/docs/16/sql-alterextension.html.
Schema rename semantics: https://www.postgresql.org/docs/16/sql-alterschema.html.
