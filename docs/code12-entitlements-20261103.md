# CODE12: server workspace allocations, 2026-11-03

## Source and acceptance

This source packet is not accepted until the merged isolated PostgreSQL gate and typechecks pass. No production migration, provider request, billing operation or live financial mutation was performed. Migration: `20261103101000_team_entitlements.sql`, after the Storage namespace and security admission migrations. The full team export includes quota usage and connector reservations, so apply this migration before running finance export snapshot acceptance.

The allocation values come from `packages/plans/src/index.ts`. SQL parity is an explicit regression:

| Effective allocation | Members | Banks | AI connectors | Team storage | Monthly Inbox | Monthly first invoice issuance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| free | 1 | 1 | 2 | 1 GiB | 50 | 5 |
| starter | 2 | 3 | 5 | 10 GiB | 150 | 15 |
| pro / trial | 10 | 10 | 20 | 100 GiB | 500 | 50 |

These are existing technical allocations, not new pricing or legal policy.

## Enforcement

A shared transaction-scoped advisory lock serializes allocation decisions per team. SQL AFTER triggers cover backend queries, REST/tRPC/MCP, worker writes and direct Data API writes. API errors expose a safe resource/allowance explanation without SQL or provider secrets. The billing settings card reads authoritative primary DB usage.

Members count distinct current memberships. Banks count connection rows plus unresolved bank cleanup records for connections whose local row was deleted. A failed connection does not release its slot. AI connectors mean Composio connections: a durable team-specific reservation precedes authorization, and pending/unknown/disconnecting states retain the slot. Native email/apps are not silently assigned a new quota category. Connector entities are `agsaas-team-<team UUID>`. Attachment cannot revive released or disconnecting records. Confirmed provider cleanup releases a reservation; unknown provider outcomes retain it. Security CODE14 owns the provider lifecycle and passes the same SQL transaction to the reservation helpers.

Inbox insertions and first invoice issuance append immutable usage evidence. Resource deletion does not erase monthly consumption. Recreating an already used resource identity is rejected; a new identity consumes another allocation. Retries of an existing resource do not charge twice. Periods use server UTC month at admission and ignore caller-supplied timestamps. Issuance means the first durable issued state, frozen document or send timestamp, including manual settlement of a draft. A rolled-back business transaction rolls back its usage.

Existing records are baselined using their retained timestamps and identities. Deleted historical records cannot be reconstructed from current tables; this limitation is explicit. No invented historical usage or financial receipt is added.

## Trial, downgrade and overdue policy

The trial allocation expires 14 days after immutable team creation. An expired/revoked trial becomes the free allocation. A paid provider binding whose entitlement was terminally revoked falls back to free. Existing trusted starter/pro allocations without a provider binding are retained for compatibility; they cannot be self-assigned by browser SQL or public team update DTOs. A payment-overdue state pauses new allocations. Downgrades and trial expiry retain existing records even when current usage exceeds the new allocation. Reading, exporting, reductions and existing issued invoice settlement remain available.

The authenticated/anon SQL trigger forbids changing plan, subscription state, billing identities/version timestamps, cancellation time or creation time. Authenticated creation can only establish a current trial. New generated-file grants cannot be created by browser or generic service-role RPC.

## Storage and generated files

Quota sums actual `storage.objects.metadata.size` for vault `<team>/...`, apps `<team>/...` and avatars `teams/<team>/...`. Existing namespace, MIME and per-object limits remain independent. Global account avatars under `users/<user>/...` are not assigned to a team that may not exist; their independent 5 MiB object cap remains. This boundary does not claim a per-account cumulative quota.

Supabase Storage v1.81.0 performs a permission probe before upload using metadata without final size. Its uploader source is the basis for allowing a rolled-back probe: https://raw.githubusercontent.com/supabase/storage/v1.81.0/src/storage/uploader.ts (authorizeUpload / prepareUpload / completeUpload). A deferred commit trigger rejects persistent unknown-size team objects. Final size growth takes the team lock and counts actual metadata. Native Storage HTTP lifecycle acceptance is still required; SQL-only tests are not presented as that acceptance.

Exports and invoice PDFs remain possible above the workspace allowance only with an internal, short-lived exact-key and exact-byte grant. An export grant requires an existing immutable export snapshot, its saved operation key and the hash-shaped archive key. An invoice grant requires the frozen document and durable generate-invoice intent for that invoice. Generic service-role identity, caller-selected path, foreign snapshot or wrong byte size is insufficient. The real generated bytes still count toward usage and block later ordinary growth. Browser roles never receive the exception. Worker export authorization fails before any Storage upload/download.

## Pending validation

`scripts/verify-team-entitlements.sh` applies only the guarded isolated migration, then runs quota PostgreSQL tests, safe-error tests, export authorization regressions and independent DB/worker/API/dashboard typechecks. Only root may schedule it via imon-job. Cases include concurrent final slots, rollback, replay, deletion/recreation, past-due/downgrade, backdated timestamps, direct SQL self-upgrade refusal, no grant creation by authenticated RPC, unknown-size probe rollback/commit refusal, Storage concurrency, exact-grant overage counting and wrong-size/foreign-source negatives.

The migration has not been applied to production. Browser/settings acceptance, actual candidate Storage upload behavior and merged full test outcomes remain separate required evidence.
