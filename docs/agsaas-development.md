# AGSAAS — development and verification

This runbook describes the behavior-preserving refactor. It does not certify a
production deployment or configure paid external providers.

## Runtime and deterministic checks

Use Bun **1.3.11**, matching the package manager, Docker images, and CI.
From the repository root:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:unit
bun run test:build
```

`typecheck` builds the Workbench library first and checks workspaces sequentially
with a larger Node heap. `test:unit` runs package, database, health, API, dashboard,
and worker suites in separate processes: Bun module mocks in some suites must not
leak into unrelated suites. Do not combine all tests into one process to save a
few seconds.

The API's `test:auth` command also runs each auth suite in its own process, with
no shared tRPC preload. Local signing keys exercise the real JWT verifier and
invitation routes; primary/replica and stale-cache fixtures exercise revocation
and membership behavior without a live auth service. `test:worker` builds the
Workbench library before testing the real admin router with in-memory queues.

Database and Redis integration tests skip when their explicit test URLs are
absent. A passing run with skipped integration tests is not an integration pass.
Expected response-validation logs in API negative tests verify rejected invalid
responses; investigate failed assertions, not log severity alone.

`test:build` builds the MCP invoice app, tests its generated output, and builds
Workbench UI/library. It is not a full dashboard production build or a native
desktop installer check. A successful desktop web bundle alone does not establish
that the native application can be distributed.

## Isolated PostgreSQL and Redis tests

Docker Compose exposes disposable services only on loopback. It is not a
production database stack and contains no production data or credentials.

```sh
docker compose -f docker-compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/midday_test bun run test:db
REDIS_TEST_URL=redis://127.0.0.1:6380/15 bun run test:redis
docker compose -f docker-compose.test.yml down
```

`test:db` creates the test prerequisites, applies the test schema, and runs the
calculation and tenant-isolation suites in separate Bun processes. Its
configuration accepts only explicit local
PostgreSQL URLs for the exact database `midday_test`, with no query parameters or
fragment. There is no fallback to an application database. The validator is used
before schema setup and before test client construction. Do not point this
destructive test harness at a real customer database.

The SQL test prerequisites provide synthetic Supabase auth functions and roles.
These allow calculation/query tests to run on PostgreSQL with pgvector; they do
not verify real Supabase authentication or production RLS. Tenant-isolation tests
use a privileged backend connection to prove explicit query-level restrictions
between two teams, not database policy enforcement.

The tenant fixture generates fresh UUIDs and removes only its own teams/users
and cascading rows. It tests authorized operations, rejected foreign IDs,
all-or-nothing batches and unchanged foreign records after rejected operations.
Three absent tracker SQL functions receive clearly marked test-only, constant
implementations solely to exercise the query shape; production tracker metrics
are not validated by those fixtures. Existing definitions are not overwritten.
Do not run this suite concurrently with calculation tests, which truncate tables.

Redis tests require an explicit loopback URL selecting database 15. Each test
uses unique queues and prefixes, closes its workers and connections, and removes
only its own queues. They do not run a global Redis flush. Use a dedicated test
Redis instance even with those safeguards.

CI provisions these services on an isolated runner, then executes the PostgreSQL
and real Redis regressions. The Redis CI port is 6379; the Compose port is 6380.

## Container builds

The API and worker must build from a clean checkout without provider secrets:

```sh
docker build -f apps/api/Dockerfile --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t agsaas-api:local .
docker build -f apps/worker/Dockerfile --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t agsaas-worker:local .
```

Bun and Turbo versions are pinned. Turbo **2.11.10** preserves a Bun-compatible
pruned dependency graph, including HTTP(S) tarball dependencies such as XLSX.
The older 2.9.3 corrupts that tuple; 2.9.4 fixes its syntax but still produces a
hoisted graph rejected by Bun 1.3.11 for this repository. The pinned 2.11.10 was
verified for the API, worker, and dashboard prune targets without changing any
non-Turbo dependency version or integrity value.
Pruned workspaces use the pruned lockfile with `--frozen-lockfile`; do not delete
the lockfile or strip its integrity values to bypass dependency errors.
The build accepts an explicit commit argument, the legacy commit stamp, or an
unstamped checkout. An empty stamp keeps the existing runtime/build-ID fallback.

In production, build an image once with a real commit identifier and run the same
image across replicas. Unstamped builds may use a random build ID and are not a
substitute for a reproducible release process.

The root Docker ignore file excludes local credentials, environment files, and
dependency/build output. Existing dashboard Sentry and Server Action build-time
secret handling still needs deployment-specific review; the API/worker build
jobs do not certify dashboard secret management. No image is pushed or deployed
by these checks.

## Application configuration

Start from the existing templates:

- `apps/api/.env-template`
- `apps/worker/.env-template`
- `apps/dashboard/.env-example`

Optional banking credentials are validated when that provider is selected. This
does not make core database, authentication, storage, or queue configuration
optional. Never add fake provider credentials merely to make imports succeed.

Worker administration requires **both** `BOARD_USERNAME` and `BOARD_PASSWORD`.
Without either value, `/admin` and `/info` are absent (404); with both, they require
HTTP Basic authentication. `/`, `/health`, `/health/ready` and job processing are
unchanged. Use HTTPS and a restricted management network in a deployment; Basic
authentication does not encrypt credentials in transit. Existing unauthenticated
monitoring of `/info` must switch to the health endpoints or supply board auth.

REST authorization now reads current key, user and team membership state from
the primary database instead of long-lived caches or replicas. This intentionally
adds authoritative lookups to prevent stale access after revocation; measure the
primary's load before setting production capacity. tRPC still deduplicates
membership resolution within each request. No cross-request positive permission
cache is used as an authorization decision.

Use service URLs and accounts owned by your deployment. This refactor does not
provision a cloud Supabase project or connect live bank, payment, email, or AI
accounts. The desktop app still contains upstream endpoints and must not be
distributed as an independent product until they are reviewed and replaced.

## Known functional boundaries

- Non-time Workbench sorting searches a fixed window of up to 1,000 candidates
  per queue and state. Pages are stable within that window, but this is not a
  global, arbitrary archive sort. Sampled metrics/search must not be presented
  as exhaustive historical analysis.
- The matching golden-test heuristic is mocked. Its diagnostic score is not a
  measured production matching accuracy; do not tune financial behavior just to
  improve that printed number.
- Real authentication-provider behavior, production RLS/storage, comprehensive
  endpoint authorization, responsive visual regressions, backup/restore, and
  production observability still require checks against the intended deployment.
  The targeted auth/tenant tests are not a security certification.
- Existing inconsistent links require a separate read-only data audit and an
  approved repair plan. In particular, relational tracker-entry reads may still
  encounter historical project/customer links that predate the new write guards,
  including other entries returned for the same dates. Customer-tag aggregates
  and inverse inbox/attachment FK cascades also need historical-integrity review.
  This pass does not rewrite customer data or deploy constraints/policies.
- Storage/file-export validation work was interrupted by an environment safety
  restriction and is excluded from the verified checkpoint. Do not count that
  unfinished work as a closed security issue. Its unvalidated source is retained
  separately on `wip/storage-review-paused-2026-10-31`; do not merge or deploy it
  without completing the review and restoring green regression checks.
- Six incompatible operator classes in four existing index declarations are
  corrected to match UUID/text column types. Index names, columns, order, and
  uniqueness remain unchanged; production schema changes are not executed.
- No Russian tax rules, bank integrations, legal invoicing requirements,
  rebranding, or new product promises are introduced by this pass. Resolve the
  upstream licensing requirements before release.
