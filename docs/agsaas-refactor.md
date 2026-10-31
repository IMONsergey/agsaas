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
schema unchanged. Refactors must have regression tests and be reviewed separately
from rebranding or replacing foreign integrations.

## First refactor

- Normalize rate-limit errors and headers without `any`; support `Headers`,
  mixed-case header names, HTTP-date `Retry-After`, and provider reset headers.
- Eliminate duplicate primary-database retry loops when a replica returns no row.
- Split API test commands into independently runnable suites.
- Limit root TypeScript checking to one workspace at a time and raise the Node
  heap size to handle the dashboard/API type graphs.
- Restore Biome compliance for the original billing script and resync `bun.lock`.

## Local verification

Run from the repository root with Bun 1.3.11:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test --exit packages/banking/src
bun test --exit apps/api/src/__tests__/db-retry.test.ts
```

Full integration tests need the configured database and third-party service
test credentials. Passing static checks and pure tests does not establish
production readiness.

## Pending high-risk work

1. Review Midday sunset/billing code before enabling payment processing.
2. Replace Supabase, hosted queues, payment, email, and banking dependencies
   with approved deployment/integration architecture.
3. Establish an isolated test database and run the complete API/DB test matrix.
4. Capture responsive UI regression snapshots before changing components.
5. Review team isolation, authorization, storage access and financial data flow.
6. Complete Russian accounting, invoice and bank requirements separately from
   behavior-preserving refactoring.
