#!/usr/bin/env bash
set -euo pipefail
export NODE_OPTIONS="--max-old-space-size=4096"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
./node_modules/.bin/biome format --write packages/db/src/queries/export-snapshots.ts packages/db/src/queries/invoices.ts packages/db/src/schema.ts packages/db/src/test/export-snapshots-postgres.test.ts packages/db/src/test/client-activity-postgres.test.ts apps/worker/src/utils/export-archive.ts apps/worker/src/utils/export-archive.test.ts apps/worker/src/processors/transactions/export.ts apps/worker/src/processors/transactions/export-team-data.ts apps/worker/src/processors/transactions/process-export.ts apps/worker/src/processors/transactions/transaction-export-format.ts apps/dashboard/src/components/export-status.tsx
cd apps/worker
bun --no-env-file test --exit --timeout 30000 src/utils/export-archive.test.ts
cd ../..
failed=0
for package in packages/db apps/worker apps/api; do
  (cd "$package" && bun run typecheck) || failed=1
done
exit "$failed"
