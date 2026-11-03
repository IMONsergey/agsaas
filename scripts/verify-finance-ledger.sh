#!/usr/bin/env bash
# Run only inside an authorized imon-job against the guarded isolated database.
set -uo pipefail
export NODE_OPTIONS=--max-old-space-size=4096
cd "$(dirname "${BASH_SOURCE[0]}")/.."
failed=0
(cd packages/workbench && bun run build) || failed=1
(cd packages/db && bun --no-env-file test --exit --timeout 30000 src/invoice-settlement.test.ts src/billing-subscription.test.ts) || failed=1
(cd apps/api && bun --no-env-file test --exit --timeout 30000 src/__tests__/invoice-refund-request.test.ts) || failed=1
(cd apps/api && bun --no-env-file test --exit --timeout 30000 src/__tests__/invoice-payment-routes.test.ts) || failed=1
(cd apps/api && bun --no-env-file test --exit --timeout 30000 src/__tests__/billing-reconciliation.test.ts) || failed=1
(cd apps/api && bun --no-env-file test --exit --timeout 30000 --preload ./src/__tests__/setup.ts src/__tests__/trpc/invoice-settlements.test.ts src/__tests__/trpc/billing.test.ts) || failed=1
bash scripts/verify-finance-postgres.sh || failed=1
bash scripts/verify-finance-all.sh || failed=1
exit "$failed"
