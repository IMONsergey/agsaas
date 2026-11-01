# AGSAAS — development and verification

This runbook describes the behavior-preserving refactor. It does not certify a
production deployment or configure paid external providers.

## Runtime and deterministic checks

Use Bun **1.3.11** for package installation, tests, and the API/worker runtimes.
The dashboard production build and standalone server use native Node **24.21.0**
from `node:24.21.0-trixie-slim`. Its image retains Bun for package installation,
health checks, and the smoke harness; the harness launches the server with Node.
The dashboard image build verifies both pinned runtime versions before continuing.
From the repository root:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:unit
bun run test:build
bun run test:build-contract
```

`typecheck` checks operational scripts, builds the Workbench library, and checks workspaces sequentially
with a larger Node heap. `test:unit` runs package, database, health, API, dashboard,
worker, and operational suites in separate processes: Bun module mocks in some suites must not
leak into unrelated suites. Do not combine all tests into one process to save a
few seconds.

The API's `test:auth` command also runs each auth suite in its own process, with
no shared tRPC preload. Local signing keys exercise the real JWT verifier and
invitation routes; primary/replica and stale-cache fixtures exercise revocation
and membership behavior without a live auth service. `test:worker` builds the
Workbench library before testing the real admin router with in-memory queues,
startup/readiness, deadline handling, and resource ownership. API startup suites
also run separately so optional-provider mocks cannot mask actual import errors.

Database and Redis integration tests skip when their explicit test URLs are
absent. A passing run with skipped integration tests is not an integration pass.
Expected response-validation logs in API negative tests verify rejected invalid
responses; investigate failed assertions, not log severity alone.

`test:build` builds the MCP invoice app, tests its generated output, and builds
Workbench UI/library. It is not a full dashboard production build or a native
desktop installer check. A successful desktop web bundle alone does not establish
that the native application can be distributed.

The separate dashboard container CI job performs a real Next production build,
then starts the generated standalone server with external networking disabled.
Its HTTP health/static-asset smoke is a packaging check, not an authenticated
browser journey. `test:build-contract` checks Turbo's strict environment, dependency
and output declarations, and verifies that release SHA, Sentry release, Server
Actions encryption key, and public endpoint changes invalidate the build cache.
The unchanged Hedvig Google Font loader still needs outbound font access during
a clean production build. The packaged runtime smoke is network-isolated; the
dependency/font download phase is not an offline-build guarantee.

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

Dashboard builds additionally need the public application/API/Supabase URLs and
publishable key for the intended deployment. `NEXT_PUBLIC_*` values are included
in browser assets at build time: changing only runtime environment variables does
not retarget an already built frontend. Never supply a server-side Supabase key
as its publishable key. Use the same build-time
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` across replicas; it must be canonical base64
of 32 random bytes. These output-affecting variables are hashed by Turbo, not
merely passed through. Provider/server secrets are not required for the CI build.

The root Docker ignore file excludes local credentials, environment files, and
dependency/build output. Existing dashboard Sentry and Server Action build-time
secret handling still needs deployment-specific review; the API/worker build
jobs do not certify dashboard secret management. No image is pushed or deployed
by these checks.

## Isolated runtime checks

Build images with the exact local test tags, then run the process checks:

```sh
docker build -f apps/api/Dockerfile -t agsaas-api:ci .
docker build -f apps/worker/Dockerfile -t agsaas-worker:ci .
bun run test:runtime api
bun run test:runtime worker
```

Each invocation creates a uniquely named Compose project on an internal-only
network, publishes no host ports, uses disposable PostgreSQL/Redis data, and
removes only its own containers/network/volumes in `finally`. It does not install
the application schema or read the service `.env` files. Database credentials
and the server-key-shaped string in this fixture are test values, not credentials
for any external account. Local test PostgreSQL uses explicit `sslmode=disable`;
this is not a recommendation for an external production database.

The final application image runs with `NODE_ENV=production`, real PostgreSQL and
Redis connections, and **no optional provider credentials**. Checks include:

- Actual HTTP liveness and readiness, including the expected core probe names.
- API rejection of missing authorization and unavailable messaging integrations;
  disabled worker administration.
- Dependency-health failure/recovery after the normal 30-second probe cache TTL,
  with liveness remaining independent of readiness.
- SIGTERM to the real application process, bounded cleanup, and exit code zero
  rather than a Docker timeout/SIGKILL.

**The Supabase endpoint in this stack is only a health transport fixture.** It
cannot authenticate users, issue tokens, enforce RLS, serve storage, or validate
signup. Its name, source, and output deliberately identify this boundary.
Worker queues are paused only in the disposable test Redis before startup:
workers/connectivity/schedulers initialize, but cron processors do not call
providers or query absent application tables. This is not job-processing E2E.

## Application configuration

Start from the existing templates:

- `apps/api/.env-template`
- `apps/worker/.env-template`
- `apps/dashboard/.env-example`

Optional banking credentials are validated when that provider is selected. This
does not make core database, authentication, storage, or queue configuration
optional. Never add fake provider credentials merely to make imports succeed.

The API now creates Resend and Composio clients only when used. Bot adapters are
enabled only when their SDK-required credential group is complete; unavailable
platform webhooks return 503 before initialization. Existing configured
integrations retain their SDK behavior. Email/AI/connectors/messaging are still
real features that require valid provider configuration when selected.
The worker payment-issue processor also creates its email client only when the
email job runs. A fresh-process regression imports all 38 registered processors
without optional-provider keys and forbids all network attempts; separate SDK
fixtures preserve the configured email payload and original failure behavior.
In particular, existing account deletion still includes Resend contact cleanup,
and email notification jobs still require Resend. Core startup success does not
certify these feature flows without their configured providers.

An offline diagnostic checks a service environment without printing its values
or making network requests:

```sh
bun --env-file=apps/api/.env scripts/runtime-doctor.ts api
bun --env-file=apps/worker/.env scripts/runtime-doctor.ts worker
bun --env-file=apps/dashboard/.env scripts/runtime-doctor.ts dashboard
```

Exit codes are 0 for no configuration errors (warnings may remain), 1 for errors,
and 2 for invalid CLI usage. This validates shape/completeness, not credentials,
schema, TLS certificates, external connectivity, or production readiness.

| Service | Core configuration |
| --- | --- |
| API | `DATABASE_PRIMARY_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `REDIS_URL`, `REDIS_QUEUE_URL`; set exact `ALLOWED_API_ORIGINS` for browser access |
| Worker | `DATABASE_PRIMARY_POOLER_URL` (existing `DATABASE_PRIMARY_URL` fallback), `SUPABASE_URL` (existing `NEXT_PUBLIC_SUPABASE_URL` fallback), `SUPABASE_SECRET_KEY`, `REDIS_URL`, `REDIS_QUEUE_URL`, `INTERNAL_API_KEY` shared with API; set `API_INTERNAL_URL` to that API |
| Dashboard build | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_URL`; stable release/key configuration for replicas |

`INTERNAL_API_KEY` is a core API/worker service credential, not an optional
third-party integration. Use the same private value in both services. Worker
internal calls use `API_INTERNAL_URL`, then `NEXT_PUBLIC_API_URL`, then the
existing development fallback `http://localhost:3003`. In separate containers,
localhost does not refer to the API container. Never expose the internal key
through a `NEXT_PUBLIC_*` variable.

BullMQ now respects the numeric database in `REDIS_QUEUE_URL` and decodes escaped
credentials. Both producers and workers use the same parser; ordinary `redis://`
and TLS `rediss://` are supported. Query strings/fragments and malformed database
paths are rejected rather than silently selecting another connection. If an
existing deployment put `/N` in its URL, earlier code incorrectly used database
0: plan a drain/cutover of the old queues before upgrading. Do not silently leave
pending jobs behind in database 0 or change only one side of the queue system.

Worker administration requires **both** `BOARD_USERNAME` and `BOARD_PASSWORD`.
Without either value, `/admin` and `/info` are absent (404); with both, they require
HTTP Basic authentication. `/` and `/health` remain liveness routes. Readiness
now stays false during startup until workers and schedulers initialize, and
becomes false synchronously when shutdown begins. Use HTTPS and a restricted
management network in a deployment; Basic
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

## Full self-hosted application bootstrap: unresolved prerequisites

Use the [official self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker)
and its matched release snapshot when selecting a local Supabase deployment;
do not mix arbitrary latest service images or replace cloud URLs with guessed
keys. No cloud project is created by this refactor.

The repository currently contains incremental SQL migrations beginning with
`0001` (which alters an already existing enum), a Drizzle schema/snapshot, and
isolated-test prerequisites. It does **not** contain a verified complete initial
Supabase bootstrap. Authoritative implementations of referenced private auth
and tracker functions, auth/onboarding triggers and deployment-specific policy
setup must be restored/reconstructed and tested before a fresh product install
can be claimed. Do not copy synthetic test auth or tracker functions into a real
deployment, run `db push` blindly against customer data, or report the runtime
smoke as a successful signup-to-invoice journey.

The migration journal also refers to `0000_silly_sage`, but the corresponding
initial SQL is absent. A read-only comparison with the imported upstream revision
`51587319f26a0ffaa9dfccab1920373cb65689b7` found the same 39 SQL migration blobs,
snapshot/journal and Supabase client files: this baseline gap was not introduced
by the AGSAAS import. Restore a version-matched bootstrap or schema-only export
(including custom functions, triggers, grants/policies and migration history),
without customer records or credentials, before treating the install as complete.

The next functional gate is an approved bootstrap against a disposable real
Supabase deployment, followed by actual registration, workspace membership,
customer/invoice/tracker and restore tests. This work does not run migrations or
repair data on a live system.

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
