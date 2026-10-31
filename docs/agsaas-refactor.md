# AGSAAS — refactor baseline

## Source of truth

- Upstream: https://github.com/midday-ai/midday
- Imported revision: `51587319f26a0ffaa9dfccab1920373cb65689b7` (2026-06-13)
- Destination: https://github.com/IMONsergey/agsaas
- Source license: AGPL-3.0. The upstream README separately requests a
  commercial license; resolve this discrepancy before selling a hosted fork.
- Upstream GitHub Actions were not imported. Their original CI/deployment
  configuration references Midday infrastructure and was not required to
  preserve the application source.

## Preservation boundary

Until the functional baseline is reproducible, keep the dashboard and website
components, CSS, assets, localization, authorized product flows, API payload
shapes, and database tables/columns unchanged. Explicit exceptions are stronger
access checks and administration boundaries: unauthorized or revoked access is
rejected, and worker `/admin` and `/info` require credentials or remain disabled.
Refactors must have regression tests and be reviewed separately from rebranding
or replacing foreign integrations. The only schema
declaration corrections in this pass are six incompatible operator classes in
four existing indexes; their names, columns, order, and uniqueness are preserved.
No production migration is executed by this work.

## First refactor

- Normalize rate-limit errors and headers without `any`; support `Headers`,
  mixed-case header names, HTTP-date `Retry-After`, and provider reset headers.
- Eliminate duplicate primary-database retry loops when a replica returns no row.
- Split API test commands into independently runnable suites.
- Extract pure bot notification formatters from the DB/provider orchestration
  module, keeping its original exports and adding regression tests for all
  notification families.
- Limit root TypeScript checking to one workspace at a time and raise the Node
  heap size to handle the dashboard/API type graphs.
- Restore Biome compliance for the original billing script and resync `bun.lock`.

## Reliability pass

- Extract pure job search and ordering from Workbench. Await BullMQ Redis
  clients, use each queue's actual prefix, paginate newest-first in Redis before
  applying limits, and make ascending fallback behavior consistent.
- Invalidate queue caches on mutations, prevent in-flight reads from restoring
  invalidated entries, and use a fixed expiry instead of extending stale cache
  lifetime on every read. Keep non-time sorting within a stable, documented
  1,000-candidate window per queue and state.
- Add queue regression tests and isolated real Redis/BullMQ tests with unique
  queues, explicit local-only configuration, and targeted cleanup.
- Validate optional banking provider credentials when the selected provider is
  used, preserving the existing exports and validation constraints. Failed
  validation remains retryable and does not expose credential values.
- Separate API and worker database readiness probes. Check only the selected
  banking provider and always close temporary Redis probe connections.
- Close chat MCP resources after initialization or tool-discovery failures,
  without replacing the original error when cleanup also fails.
- Construct recurring invoice calendar dates directly in the invoice timezone;
  cover host-timezone independence, including UTC+14.
- Stub QuickBooks at its OAuth SDK boundary so connection tests cannot call the
  live provider; restore only each test's own spy.
- Pin Docker Bun and Turbo versions, install the pruned frozen lockfile, accept
  optional commit stamps, and exclude local credentials and build output from
  Docker contexts. Keep dashboard presentation code unchanged.
- Pin Turbo 2.11.10 to correct Bun URL-dependency serialization and hoisted-graph
  pruning. Preserve non-Turbo dependency versions and integrity checks; keep
  the frozen lockfile check enabled for all three container build targets.
- Separate mock-heavy test suites, typecheck Workbench tests without emitting
  them in the library, and add explicit embedded-client build checks.
- Guard disposable PostgreSQL test setup before constructing clients or
  applying schema changes. Add local-only PostgreSQL and Redis CI services and
  clean API/worker container builds.
- Correct invalid UUID/text index operator classes that prevent creating the
  declared schema on fresh PostgreSQL. Bootstrap the required `pg_trgm`
  extension and synthetic `authenticated` role only in the isolated test setup.

## Authorization and tenant-boundary pass

- Derive invitation email identity from the verified JWT's top-level email,
  never from user-editable profile metadata. Keep display-name metadata and
  supported asymmetric/legacy HMAC authentication working.
- Check current team membership on the primary database for REST JWT, OAuth,
  and API-key access. Read API-key status/scopes and user state from the primary
  instead of trusting stale authorization caches. Preserve onboarding without
  an active team and valid tokens for a different team the user still belongs to.
- Make the primary membership result authoritative for tRPC while retaining
  request-local batched-call deduplication and downstream replica routing.
- Scope invoice, customer, tracker-entry and API-key conflict/update branches
  to the caller's team. Validate linked customers, templates, projects, assignees,
  transactions and tags before mutations. Keep batch validation and dependent
  writes in one transaction; use shared row locks to keep ownership stable until
  commit. Token generation and external work stay outside those locks.
- Restrict attachment deletion's inbox, matching, tax and accounting side
  effects to the same team, including a regression for legacy inconsistent links.
- Disable worker `/admin` and `/info` routes unless both board credentials are
  configured. Protect both endpoints when enabled without restricting health
  checks or background processing. Test the actual router inside the final
  worker image with networking disabled.
- Serve Workbench assets only by validated flat filenames; preserve normal
  JavaScript, CSS and binary asset responses and missing-file behavior.

Signed-token regressions use local cryptographic keys and the real verifier;
authorization database responses are controlled fixtures. Query-boundary tests
run separately against real disposable PostgreSQL with two synthetic teams.
These are targeted code changes and regression checks, not a complete security
audit or validation of a live auth/storage deployment.

## Local verification

Run from the repository root with Bun 1.3.11:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:unit
bun run test:build
```

The unit suite includes API contracts, accounting, banking, notification
formatting, documents, encryption, import, inbox, insights, invoice calculations,
health probes, queue behavior, signed-token authorization, worker administration,
static asset boundaries, and dashboard utilities. Database and Redis tests
are skipped without their explicit isolated-service configuration; skipped tests
are not evidence of integration correctness. Build-output tests run separately.

See [the development and verification runbook](agsaas-development.md) for exact
service commands, safety boundaries, and the distinction between unit tests,
isolated integration checks, and a production deployment. Passing static checks
and pure tests does not establish production readiness.

## Pending high-risk work

1. Review Midday sunset/billing code before enabling payment processing.
2. Replace Supabase, hosted queues, payment, email, and banking dependencies
   with approved deployment/integration architecture.
3. Verify the intended auth deployment, database policies, storage, and provider
   integrations. New tests cover selected application/query tenant boundaries,
   not production RLS or all access paths; the isolated database setup uses
   synthetic auth functions and test-only tracker metric placeholders.
4. Capture responsive UI regression snapshots before changing components.
5. Complete the remaining storage/file-export review and audit existing data
   for inconsistent cross-team links. Historical tracker project-to-customer
   links can still affect relational tracker-entry reads and customer-tag
   aggregates. Existing inverse inbox/attachment links also retain database FK
   cascade behavior. Preventing new invalid mutations does not repair existing
   records. The interrupted storage work is not part of this verified checkpoint.
6. Complete Russian accounting, invoice and bank requirements separately from
   behavior-preserving refactoring.
7. Replace upstream desktop endpoints before distributing a branded native app.
8. Evaluate matching quality against reviewed production-like fixtures; the
   mocked heuristic score in golden tests is not a production accuracy metric.
