# Infra PostgreSQL gate selection — 2026-11-03

This is a source audit and execution plan for the **synthetic PostgreSQL 16.15
fixture**. It is not a declaration that every listed suite has passed, nor
canonical Supabase Auth/Storage/PostgreSQL 17 acceptance.

## Confirmed foundation evidence

The coordinator's job `20261103T093013-b101a16ad8` passed all eight foundation
guard tests and read-only inspection. The full source lock contains the unchanged
baseline plus all 31 real upgrades. Its source-set fingerprint is
`343e96a887bd93aac9f0eec6c1d22a4873f01819ecefcbdff3d3af8071052ff3`.

Rehearsal job `20261103T093652-28ba23245d` passed at 09:40:12 UTC. The complete
baseline and 31 upgrades executed in one PostgreSQL transaction; an intentional
final `22P02` error was followed by verified ROLLBACK. The before/after catalog
fingerprint was exactly
`5e9e83f45bf926be8a82366fc4698a9d5bd84ba2b513b7cab0344f74d8e8d150`.
The coordinator separately approved and queued the actual synthetic fixture
commit. Its outcome must be recorded from that job, not inferred from rehearsal.

The archived original schemas and separate synthetic provenance must remain.
Do not create Supabase migration history to make the fixture look canonical.

## Infra suites to run serially after the fixture commit

Paths below are relative to `packages/db/src/test/`. Use one process per suite,
the shared job queue and the guarded private `TEST_DATABASE_URL`. Do not start
another database suite while one of these has an open pool or transaction.

| Suite | Source review | Persistent effects and conditions |
| --- | --- | --- |
| `migration-chain-postgres.test.ts` | Actual transaction/history rollback checks, with complete `finally ROLLBACK` paths. | Creates a private test table and temporary canonical-history tables only inside transactions. New regression from `1f49f52c` checks the actual legacy setup refusal. No permanent history or Auth changes. |
| `onboarding-deliveries-postgres.test.ts` | Fixture creation, actual migration replay and all assertions are inside `BEGIN`/`finally ROLLBACK`. | A historical-profile case temporarily disables/re-enables its onboarding trigger inside that transaction; it cannot persist. Existing Auth-to-profile trigger is handled by `ON CONFLICT`. No real mail is sent. |
| `native-bank-sync-postgres.test.ts` | Most cases replay real migration SQL inside rollback transactions. One case commits its own synthetic rows to race two SQL connections. | Requires `1fe6eab456725ca4bd64024510c57282e69a271c`: the committed case does **not** replay migration DDL. It relies on the installed foundation, commits only its rows and deletes its own two teams in `finally`. Real provider calls and Redis are not involved. |

The migration-chain suite tests migration-runner transaction semantics with a
small SQL chain. Evidence that the actual full application chain ran comes from
the separate foundation rehearsal described above.

The companion `self-hosted-bootstrap.test.ts` is an **offline** generator test.
It reads SQL, examines Drizzle metadata and uses `drizzle.mock`; it does not
connect to PostgreSQL or reset the fixture. Keep it with the unit/generator gate.

## Historical upgrade suites: separate processes and remaining prerequisites

All three specifically audited suites below have their DDL and role changes
inside rollback transactions. Their `beforeAll` hooks only create pools/read SQL.

| Suite | Decision and reason |
| --- | --- |
| `upgrade-bank-cleanup-postgres.test.ts` | Can run in a separate process after ordinary suites finish. It drops only the cleanup table inside a transaction, applies the exact upgrade, tests backend/browser grants and rolls back. Cleanup intent deliberately has no foreign key to the deleted team; the reviewed later SQL does not add an incoming FK. |
| `upgrade-inbox-oauth-postgres.test.ts` | Defer until Auth-first fixture seeding is integrated. Its direct `INSERT public.users` violates the full baseline's Auth FK. The DROP/recreate and negative already-upgraded case both roll back; no global reset is needed. |
| `upgrade-oauth-retention-postgres.test.ts` | Defer until Auth-first seeding is integrated. It reconstructs the former author FK under table locks, then restores it by ROLLBACK and explicitly checks the old FK definition and zero remaining fixture rows. Direct public profile inserts are the current compatibility blocker. |

`upgrade-financial-retention-postgres.test.ts` and the timer case in
`upgrade-invoice-documents-postgres.test.ts` also contain direct public profile
seeding and need the same review. Finance owns those fixture follow-ups. Other
historical upgrade suites must be reviewed independently for full-chain
dependencies before inclusion; a filename match is not proof that reconstructing
an old version is compatible with later guards.

These historical suites are not substitutes for normal queries against the full
installed schema. Do not run their table/constraint rewrites concurrently with
committed-fixture tests.

## Exclusions and protective fixes

| Command or suite | Reason and next step |
| --- | --- |
| `test:e2e:setup`, `setup-test-database.ts`, `setup-test-db.sql`, Drizzle push | The legacy setup is for a bare calculation database. It replaces Auth and membership helpers with constant stubs. `1f49f52cf481795d2b27905597df5cc6d3cf73b1` adds an initial refusal when synthetic provenance, canonical baseline installation or migration history exists. The standard chained setup therefore stops before Drizzle push. Never force a direct push over this foundation. |
| `calculations-e2e.test.ts` | Calls shared-table `TRUNCATE ... CASCADE`, then seeds a public user without Auth. Use a separately reviewed fixture or adapt its data lifecycle; it must not share the current acceptance fixture as-is. |
| `auth-session-revocation-postgres.test.ts` before the security fixture fix | Its old `beforeAll` permanently rewrites Auth helpers and replays global session policies, while cleanup removes only its own table. Security is replacing this with installed-foundation prerequisites and an isolated own RLS fixture. Include only after that change is reviewed. |
| `apply-entitlements-test-migration.ts` | Contains a conditional persistent migration and COMMIT. The full foundation already installs it; do not use this partial installer as an acceptance prerequisite or recovery shortcut. |
| Wildcard `bun test packages/db/src` / legacy aggregate `test:e2e` | Mixes obsolete setup assumptions, shared TRUNCATE fixtures, rollback DDL and normal queries. The coordinator should name the intended suites explicitly and record per-suite results. |

The updated finance readiness helper is read-only; older copies that applied
selected migrations are obsolete. Do not run helpers from an old worktree to
repair the new fixture.

## Redis gate status and scope

`6adee0d906ee60d2f9a4a1b17d6ef052a5a8f708` uses BullMQ 5.81.5's actual
`IRedisClient` contract: named Lua commands through `defineCommand`/`runCommand`
and structured `WITHSCORES` options. Reserve/release remain atomic Lua commands.
Rotation uses `ZADD XX` so reconciliation cannot recreate a reservation that
completion just removed. The existing isolated Redis suite now executes this
production adapter path and tests that race.

No test Redis was started by infra. `TEST_REDIS_URL` was not found in accessible
completion report environment files or the accessible runtime environment
search; one runtime path was permission-denied, so this is not a host-wide
absence claim. `redis-server`, `redis-cli` and `valkey-server` were absent from
the observed command PATH. The Redis suite requires an explicit local,
non-default disposable database URL and must not be pointed at the live queue.

## Evidence boundaries

Source review establishes intended transaction and cleanup boundaries. Only
actual queued test receipts establish runtime results. The original heavy queue
lock and runtime services have not been replaced or stopped. Root-owned BuildKit
quarantine installation, real Docker failure recovery, canonical Auth/Storage
bootstrap, production image builds and browser acceptance remain separate gates.
