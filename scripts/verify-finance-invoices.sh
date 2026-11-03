#!/usr/bin/env bash
set -euo pipefail
export NODE_OPTIONS="--max-old-space-size=4096"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
./node_modules/.bin/biome format --write packages/db/src/queries/invoice-commands.ts packages/db/src/test/invoice-commands-postgres.test.ts packages/db/src/test/upgrade-invoice-commands-postgres.test.ts packages/db/src/queries/index.ts apps/api/src/trpc/routers/invoice.ts apps/api/src/rest/routers/invoices.ts apps/api/src/mcp/tools/invoices.ts apps/api/src/mcp/schemas.ts apps/api/src/schemas/invoice.ts apps/api/src/__tests__/trpc/invoices.test.ts apps/worker/src/utils/financial-job-dispatch.ts apps/worker/src/utils/financial-job-dispatch.test.ts apps/worker/src/processors/invoices/invoice-email-delivery.test.ts
cd apps/worker
bun --no-env-file test --exit --timeout 30000 src/utils/financial-job-dispatch.test.ts
bun --no-env-file test --exit --timeout 30000 src/processors/invoices/invoice-email-delivery.test.ts
cd ../api
bun --no-env-file test --exit --timeout 30000 --preload ./src/__tests__/setup.ts src/__tests__/trpc/invoices.test.ts src/__tests__/routers/invoices.test.ts
cd ../..
failed=0
for package in packages/db apps/worker apps/api; do
  (cd "$package" && bun run typecheck) || failed=1
done
exit "$failed"
