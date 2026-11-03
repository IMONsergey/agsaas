#!/usr/bin/env bash
set -uo pipefail
export NODE_OPTIONS="--max-old-space-size=4096"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
failed=0
./node_modules/.bin/biome format packages/db/src/queries/invoice-commands.ts packages/db/src/queries/export-snapshots.ts packages/db/src/queries/invoices.ts packages/db/src/queries/reports.ts packages/db/src/schema.ts packages/db/src/test/invoice-commands-postgres.test.ts packages/db/src/test/upgrade-invoice-commands-postgres.test.ts packages/db/src/test/export-snapshots-postgres.test.ts packages/db/src/test/client-activity-postgres.test.ts packages/db/src/test/shared-report-snapshots-postgres.test.ts packages/db/src/test/upgrade-shared-report-snapshots-postgres.test.ts packages/db/src/test/helpers/apply-finance-test-migrations.ts apps/api/src/__tests__/setup.ts apps/api/src/__tests__/trpc/invoices.test.ts apps/api/src/__tests__/routers/invoices.test.ts apps/api/src/__tests__/mcp/invoice-commands.test.ts apps/api/src/rest/routers/invoices.ts apps/api/src/trpc/routers/invoice.ts apps/api/src/mcp/tools/invoices.ts apps/api/src/__tests__/trpc/reports.test.ts apps/api/src/schemas/reports.ts apps/api/src/trpc/routers/reports.ts apps/worker/src/utils/export-archive.ts apps/worker/src/utils/export-archive.test.ts apps/worker/src/processors/transactions/export.ts apps/worker/src/processors/transactions/export-team-data.ts apps/worker/src/processors/transactions/process-export.ts apps/dashboard/src/components/export-status.tsx apps/dashboard/src/components/public-metric-view.tsx apps/dashboard/src/components/metrics/components/share-metric-button.tsx apps/dashboard/src/components/metrics/components/share-metric-modal.tsx apps/dashboard/src/components/metrics/cards/profit-card.tsx apps/dashboard/src/components/metrics/cards/monthly-revenue-card.tsx apps/dashboard/src/components/metrics/cards/revenue-forecast-card.tsx || failed=1
# Each mocked API suite receives a fresh Bun module registry. Resource admission
# has its own real SQL/HTTP suites; this preload is restricted to business mocks.
resource_preload=()
if [[ -f apps/api/src/__tests__/unit-resource-admission.ts ]]; then
  resource_preload=(--preload ./src/__tests__/unit-resource-admission.ts)
fi
(cd packages/workbench && bun run build) || failed=1
(cd apps/worker && bun --no-env-file test --exit --timeout 30000 src/utils/financial-job-dispatch.test.ts) || failed=1
(cd apps/worker && bun --no-env-file test --exit --timeout 30000 src/processors/insights/dispatch-insights.test.ts) || failed=1
(cd apps/worker && bun --no-env-file test --exit --timeout 30000 src/processors/invoices/invoice-email-delivery.test.ts) || failed=1
(cd apps/worker && bun --no-env-file test --exit --timeout 30000 src/utils/export-archive.test.ts) || failed=1
for file in src/__tests__/trpc/invoices.test.ts src/__tests__/routers/invoices.test.ts src/__tests__/trpc/reports.test.ts src/__tests__/trpc/owner-procedures.test.ts src/__tests__/mcp/invoice-commands.test.ts; do
  (cd apps/api && bun --no-env-file test --exit --timeout 30000 "${resource_preload[@]}" --preload ./src/__tests__/setup.ts "$file") || failed=1
done
for package in packages/db apps/worker apps/api apps/dashboard; do
  (cd "$package" && bun run typecheck) || failed=1
done
exit "$failed"
