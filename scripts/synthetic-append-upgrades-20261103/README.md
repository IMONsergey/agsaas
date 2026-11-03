# Two append-only synthetic-fixture upgrades — prepared runner

**Preparation only. This package does not authorize or schedule execution.** No database connection, inspection query, DDL, approval request or queue submission was performed while preparing it.

The runner targets only the already reviewed synthetic PostgreSQL fixture. It does not assert working Supabase Auth/Storage services, PostgreSQL 17 acceptance or canonical Supabase migration history.

## Exact inputs

| Input | Required value |
|---|---|
| OS identity and execution | Real and effective UID 1000, actual `imon-job@…service` cgroup |
| Credential source | `/home/sergey/Work/Reports/agsaas-completion-20261103/private/database.env`, regular file owned by UID 1000, mode 0600; exactly one literal `TEST_DATABASE_URL` assignment |
| Network endpoint | `127.0.0.1:55439`; no DNS, alternate host, URL override or SSL option except explicit `sslmode=disable` |
| Database | `midday_test` |
| PostgreSQL system identifier | `7703819082990792743` |
| Foundation marker | `private.agsaas_synthetic_fixture_provenance`, operation `0f191da4-bb92-4262-bcdb-2195cf109bcd` |
| Foundation source set | `343e96a887bd93aac9f0eec6c1d22a4873f01819ecefcbdff3d3af8071052ff3` |
| New batch operation | `65020b23-1d5d-4c91-ad04-5694abcaf2bc` |
| Existing pg dependency | Frozen `/home/sergey/Work/agsaas-postgres-review-20261103`, clean HEAD `e97363ad33b08a1737e7ea77dffadc7a868db355`, already installed `pg` 8.23.1 |

The two full SQL files execute in this fixed order:

1. `/home/sergey/Work/finance-resume-source-20261103/packages/db/self-hosted/upgrades/supabase/migrations/20261103110000_invoice_refund_requests.sql` — SHA256 `acf11ab88ab8ebb5aa05b90dafd9b22560802aa443bd74e6d03c8dabc2ed0ddb`, reviewed Git source `c848d0d183d47f864268e2ed42316c7faf898d4e`.
2. `/home/sergey/Work/security-consent-20261103/packages/db/self-hosted/upgrades/supabase/migrations/20261103111000_plaid_hosted_consent.sql` — SHA256 `d0c6fc87d32cfec15561f4814475d6db1d6e08fc777fad6f5dc5d18d502a4933`, reviewed Git source `a32467248cdd027fc18f7b660d13861089790c2b`.

Both working files and immutable Git objects must match their exact hashes. Unrelated later source commits do not invalidate these two byte identities; any SQL change requires a new review. No dependencies are installed or modified.

## Modes and transaction boundaries

`inspect` opens a read-only transaction, acquires the foundation's transaction advisory lock `(1095193409, 20261103)`, checks exclusive fixture use, the live system identity, full foundation-marker fingerprint, target object state and the catalog. It returns the exact catalog SHA needed for the next step. It creates no SQL objects or rows.

`rehearse --catalog-sha256 SHA` requires the inspected catalog to remain unchanged. In one transaction, it executes both complete SQL files and creates a separate private append-only provenance table with this batch's source hashes and receipt. It then deliberately raises PostgreSQL `22P02`, rolls back, reacquires the advisory lock in a read-only transaction and compares the complete captured catalog and foundation-marker fingerprints. Only exact equality returns `rollback-verified`. A failed rollback or lost connection is never labeled verified.

`commit --catalog-sha256 SHA --rehearsal FILE` requires the successful rehearsal receipt from the same worker and launcher bytes, source manifest, original catalog, foundation marker, endpoint and system identity. It applies the same transaction and stores the new receipt. After COMMIT it reads the receipt and catalog back. Loss of the COMMIT response reports an unknown outcome; a later post-commit verification failure explicitly reports that COMMIT was acknowledged. Neither case is automatically replayed.

A repeat checks the existing append-only receipt, exact source and runner hashes, original foundation fingerprint, current full catalog and expected objects. It returns `already-applied-verified` only when all match. A partial upgrade, preexisting target table without this receipt, changed source, unrecognized journal or catalog drift causes refusal. There is no `IF NOT EXISTS` adoption or guessed repair.

## Provenance and confidentiality

The new table is `private.agsaas_synthetic_upgrade_provenance`. It has a separate operation identity and source manifest. UPDATE, DELETE and TRUNCATE are rejected by triggers; application/Auth/Storage roles receive no rights. The existing foundation marker is only read and checked before/after. `supabase_migrations.schema_migrations` is not modified or fabricated.

The launcher starts Node with a minimal environment, reads the private env as literal text without shell evaluation, and never logs its value. `DATABASE_URL`, ambient `PG*`, provider credentials, `NODE_OPTIONS` and dotenv state are not inherited. The worker fixes host/port/database explicitly and emits only bounded refusal codes/SQLSTATE. Raw driver stderr is not retained or displayed. Each actual queue job writes a new mode-0600 `result.json` under a mode-0700 report directory named for its mode and real queue ID.

The catalog contains schema/object metadata; routine bodies are hashed in memory, and application row contents are not read. Archives from the foundation are included. DML values and PostgreSQL's internal OID allocation counter are not part of catalog equivalence. This is a synthetic SQL rehearsal, not service or production acceptance.

## Commands for the parent to review — not executed

The installed source location is `scripts/synthetic-append-upgrades-20261103` in the finance repository. Only the root coordinator may decide when to enqueue these steps. The catalog and receipt placeholders must come from the actual completed preceding job.

```bash
/usr/local/bin/imon-job submit \
  --cwd /home/sergey/Work/finance-resume-source-20261103 \
  --timeout 300 \
  -- /usr/bin/python3 scripts/synthetic-append-upgrades-20261103/run.py inspect
```

```bash
/usr/local/bin/imon-job submit \
  --cwd /home/sergey/Work/finance-resume-source-20261103 \
  --timeout 300 \
  -- /usr/bin/python3 scripts/synthetic-append-upgrades-20261103/run.py rehearse \
  --catalog-sha256 '<SHA64_FROM_INSPECT>'
```

```bash
/usr/local/bin/imon-job submit \
  --cwd /home/sergey/Work/finance-resume-source-20261103 \
  --timeout 300 \
  -- /usr/bin/python3 scripts/synthetic-append-upgrades-20261103/run.py commit \
  --catalog-sha256 '<SHA64_FROM_INSPECT>' \
  --rehearsal '/home/sergey/Work/Reports/agsaas-completion-20261103/synthetic-append-upgrades-rehearse-<ACTUAL_JOB_ID>/result.json'
```

After any interrupted commit, enqueue `inspect` first. Do not reconstruct a receipt, change a pinned hash, alter the baseline marker, clear a table or bypass the queue to force a retry. Source-lock refresh for the complete production chain remains a separate root-owned action.
