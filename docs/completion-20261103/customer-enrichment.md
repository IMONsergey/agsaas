# Durable customer enrichment

CODE-28 implementation, acceptance pending until the recorded unit and PostgreSQL commands succeed.

Requests persist a team-bound SQL operation before any Redis submission. A minute scheduler rediscovers queued work and expired leases. Each execution claims a unique attempt token and a 60-second lease; the external request has a 30-second abort deadline. Cancellation invalidates the current operation and the worker polls its authority to abort transport. Applying fields and recording completion occur in one transaction after a final current-operation/attempt/lease check. Late success and late failure cannot overwrite a newer operation. Retries are bounded to three attempts, and missing provider configuration becomes a visible terminal failure. Existing manual billing details still use the fill-empty-at-write policy.

Older jobs without operation identity are ignored. Automatic requests are disabled when COMPANY_ENRICH_API_KEY is missing. A queue outage keeps a recoverable pending SQL intent; it does not lose the user's request.

Validation: apps/worker/src/utils/customer-enrichment-operation.test.ts; packages/db/src/test/customer-enrichment-operations-postgres.test.ts with guarded isolated TEST_DATABASE_URL. Test coverage includes concurrent claims, loss of Redis submission, cancel/late result, old/new attempt races, expired leases, team boundaries and manual edits. No provider requests are sent by these tests.
