#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${TEST_DATABASE_URL:?An explicit isolated midday_test database is required}"
bun --no-env-file run packages/db/src/test/helpers/apply-finance-test-migrations.ts
cd packages/db
failed=0
for file in src/test/invoice-commands-postgres.test.ts src/test/upgrade-invoice-commands-postgres.test.ts src/test/export-snapshots-postgres.test.ts src/test/client-activity-postgres.test.ts src/test/shared-report-snapshots-postgres.test.ts src/test/upgrade-shared-report-snapshots-postgres.test.ts src/test/invoice-settlement-postgres.test.ts src/test/invoice-settlement-authority-postgres.test.ts src/test/invoice-payments-postgres.test.ts src/test/billing-subscription-postgres.test.ts; do
  bun --no-env-file test --exit --timeout 30000 "$file" || failed=1
done
exit "$failed"
