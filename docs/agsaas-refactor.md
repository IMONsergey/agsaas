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
components, CSS, assets, localization, public routes, API contracts, and database
tables/columns unchanged. Refactors must have regression tests and be reviewed
separately from rebranding or replacing foreign integrations. The only schema
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
health probes, queue behavior, and dashboard utilities. Database and Redis tests
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
3. Verify real authentication, team isolation, database policies, storage, and
   provider integrations; isolated calculation tests use synthetic auth stubs.
4. Capture responsive UI regression snapshots before changing components.
5. Review team isolation, authorization, storage access and financial data flow.
6. Complete Russian accounting, invoice and bank requirements separately from
   behavior-preserving refactoring.
7. Replace upstream desktop endpoints before distributing a branded native app.
8. Evaluate matching quality against reviewed production-like fixtures; the
   mocked heuristic score in golden tests is not a production accuracy metric.
