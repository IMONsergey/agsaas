#!/usr/bin/env bash
# Authorized imon-job only, against guarded isolated midday_test DB.
set -uo pipefail
export NODE_OPTIONS=--max-old-space-size=4096
cd "$(dirname "${BASH_SOURCE[0]}")/.."
failed=0
bun --no-env-file run packages/db/src/test/helpers/apply-entitlements-test-migration.ts || exit 1
(cd packages/db && bun --no-env-file test --exit --timeout 30000 src/test/team-entitlements-postgres.test.ts src/team-quota-error.test.ts) || failed=1
(cd apps/worker && bun --no-env-file test --exit --timeout 30000 src/utils/export-archive.test.ts) || failed=1
for package in packages/db apps/worker apps/api apps/dashboard; do (cd "$package" && bun run typecheck) || failed=1; done
exit "$failed"
