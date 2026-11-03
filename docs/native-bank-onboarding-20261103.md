# Native bank synchronization and onboarding delivery

## Status and dependencies

This is a source continuation prepared locally after Remote Desktop Commander
reached its monthly limit. It has not been committed on the server, deployed,
or run against PostgreSQL/Bun. The separate validation receipt records syntax
parsing and integration-finalizer checks only. Do not mark CODE13 or CODE33 as
runtime-complete from this packet.

Apply after the merged security/finance/root infrastructure packets, including
the root timeout factory, security ownerProcedure/team-membership transaction
helpers, financial-job dispatches, resource admission and quota migration
20261103101000. This packet reserves:

- `20261103102000_native_bank_sync.sql`
- `20261103103000_onboarding_deliveries.sql`

The immutable migration-chain runner must discover these in order after the
earlier upgrades. Never rewrite a previously installed baseline or mark an
unverified Drizzle-created test catalog as having applied the migration chain.

## Banking behavior

Connection creation and changes to its credentials, reference, enrollment,
provider, team, consent status or expiry write durable SQL intent in the same
transaction. Account insertion, identity changes, disabling or deletion rotate
the operation revision. Redis contains only a wake-up with connection/team IDs;
it never receives credentials or browser-provided provider references. A minute
reconciler recovers lost queue publication, and a stable per-connection job ID
prevents an unavailable worker from accumulating duplicate wake-ups.

Each bounded lease synchronizes one enabled account. Provider credentials and
identity come from a current primary-database claim. The worker rechecks the
lease before external reads, forwards the timeout's AbortSignal to real HTTP
transports, and commits only if the connection revision, account and lease still
match. Connection/account/operation locks have a consistent order; connection
locking is exclusive before any later metadata update, avoiding lock upgrades.
Large connections progress through durable per-account checkpoints.

Provider responses are validated as one batch before SQL writes. Upserts retain
manual name, description, category, note and enrichment. Pending transactions
can become posted; changed amount/date/currency returns an exported transaction
to posted while the finance export snapshot remains immutable. Cross-account
identity collisions reject the whole batch. The current storage uses two decimal
places, so unsupported precision is rejected explicitly. Unknown balances do not
erase the last known balance. Checkpoints, financial changes and downstream
enrichment/matching dispatch records commit in one transaction.

Manual synchronization uses the own owner-only API and polls durable SQL status.
Plaid/Teller webhook delivery requests the same operation and coalesces repeated
signed event bodies. Stale webhook status updates also require the saved provider
reference/enrollment to still match. Callback destinations derive from the own
configured API origin; there is no upstream deployment fallback.

**The verified new-consent lifecycle from CODE04 remains closed.** This packet
does not make browser link/create/reconnect/exchange/addAccounts safe or enable
them. Future verified create/reconnect must save credentials and account IDs in
one server transaction; the SQL triggers then produce synchronization intent.
The legacy initial-connection/consent UI requires a subsequent complete consent
acceptance pass. Provider credentials, sandbox/live API acceptance, pagination
coverage for real institutions and operational metrics remain open gates.

## Onboarding behavior

A new local profile transaction creates at most one welcome and one optional
activation delivery. A migration-time watermark prevents bulk mailing existing
users. The reconciler recovers a missing profile event without historical replay.
The former registration webhook returns 410, and the legacy Trigger onboarding
task fails visibly instead of creating a second external owner.

The trusted recipient comes from the currently verified Auth email, not the
editable profile email. After rendering, a SQL claim rereads Auth deletion/ban,
profile deletion, current team membership, current preferences and activation
eligibility. A changed identity invalidates a prepared envelope before the first
attempt; a change after an attempted delivery requires review. Welcome opt-out
is honored across current memberships. Product tips require an actual saved
opt-in and do not create a marketing contact.

The exact envelope and hash are frozen before transport. Only a confirmed
provider receipt becomes accepted. A timed-out, lost, malformed or ambiguous
response becomes reconciliation and is not automatically resent. An expired
sending lease is similarly fenced; its original late confirmed receipt may
still settle that attempt. Only definite pre-acceptance rejection classes are
retryable, using the same idempotency identity. Missing email configuration stays
pending without consuming a send attempt. No email was sent during preparation.

The private delivery ledger provides operational evidence, but an operator
reconciliation interface, real configured sender acceptance and monitored
delivery outcomes still require the merged product/runtime acceptance pass.

## Pending validation

The packet contains **20 real PostgreSQL regression cases** (10 bank, including
one genuine two-connection race, and 10 onboarding) and **16 pure unit cases**
(5 retry/abort, 2 own callback origin, 4 payload and 5 wake-up identity cases).
They have not been executed. A skipped database suite is not acceptance.

Use the approved isolated database and the normal serialized resource queue.
First apply the complete ordered chain in a fresh verified catalog; do not run
a clean Drizzle push over migrated state. Run independent commands with an
aggregate exit status so one failure does not hide the other suites:

```sh
bun --no-env-file test --exit --timeout 30000 packages/db/src/test/native-bank-sync-postgres.test.ts
bun --no-env-file test --exit --timeout 30000 packages/db/src/test/onboarding-deliveries-postgres.test.ts
bun --no-env-file test --exit packages/banking/src/utils/retry-signal.test.ts packages/banking/src/utils/own-webhook-url.test.ts
bun --no-env-file test --exit apps/worker/src/utils/native-bank-payload.test.ts packages/job-client/src/native-wakeup.test.ts
```

Then run the merged banking/db/notifications/job-client/worker/API/dashboard
typechecks and the existing security/finance regression gates. A private test
environment must be injected by the queue; the commands do not load project env
files. The two-connection case commits only uniquely named synthetic fixtures so
both connections can see them, then removes its own rows in finally. Other PG
cases roll back their fixture transaction.

Provider configuration is optional and limited to server API/worker Compose
environment; dashboard receives no provider secrets. A synthetic candidate must
keep these fields blank. End-to-end banking and sender acceptance require
explicitly approved real or sandbox configuration and cannot be inferred from
source, empty credentials or a disabled feature.
