# Security completion checkpoint — 2026-11-03

Worktree: `/opt/agsaas/work/security-20261103`, base `8269ed3d2c25a0b6b92510b173594b08dfd5b473`.

## Public credentials and team administration (CODE-03, CODE-16)

Implemented an explicit public app DTO. Integration credentials, unknown provider config and unreviewed nested config fields never pass through the apps list or settings/disconnect responses. Internal single-app credential queries remain server-only. Existing UI metadata for accounting and messaging connections is allowlisted. Unknown providers expose no config. App settings expose their documented UI fields only.

Added a shared `ownerProcedure` and fresh primary role check. Owner-only operations now include team settings and base currency, API-key listing and management, integration settings/disconnection, Stripe Connect/disconnection and invoice refunds. REST team updates use the same primary role boundary. Membership/MFA gates still execute before this check. Everyday team reads are unchanged. Integration OAuth callbacks still require the separate consent-lifecycle packet; this checkpoint does not claim they are complete.

Tests authored: `packages/db/src/test/public-app.test.ts`, additional transport marker regression in `apps/api/src/__tests__/trpc/apps.test.ts`, `apps/api/src/__tests__/trpc/owner-procedures.test.ts`. They exercise actual DTO projection and tRPC procedure middleware with local IO substitutes. No live provider calls were performed.

**Validation status:** runtime tests for this packet are pending the root-coordinated queue. The first existing CODE-01 test job is `20261103T055323-5279b77ca1`; it includes package typechecks but does not yet include the newly authored DTO/owner suites. Do not treat this commit as release acceptance until those suites and integration checks pass.

## Other packets in progress

- CODE-01: shared canonical team Storage path contract, DB ingress, team-bound clients for active and legacy workers. Current snapshot awaiting the above job; not yet included in this commit.
- CODE-06: assistant scope/credential provenance and readiness boundaries, separate packet pending test run.
- CODE-04: pending bank consent ownership must cover link/exchange/create/reconnect and direct bank-connection reference updates, not only account listing. A fail-closed interim state is distinct from working provider onboarding.
- CODE-27: diagnostics and telemetry minimization planned.
- CODE-18: immutable receipt object keys planned.

All server operations use Remote Desktop Commander. No external OAuth flows, email deliveries, payments or live exploits were executed.

## Tenant Storage boundary packet (CODE-01)

Canonical path validation is shared by DB ingress and Storage clients through `@midday/utils/storage-path` (the Supabase entry point remains compatible). `createTeamClient(teamId)` enforces canonical tenant paths before the Supabase SDK normalizes URLs; batch, move/copy and prefix operations fail closed. The unscoped job client rejects all Storage access. Every discovered service Storage caller in active BullMQ, retained Trigger jobs and the bot now uses the team-bound client. Legacy HEIC jobs carry the explicit team scope.

API batches validate all paths before balance updates, state changes or enqueues. DB attachment/inbox creation rejects foreign/malformed paths before writes. Attachment processing checks transaction ownership; inbox processing checks linked-mailbox ownership. Export readers reject poisoned persisted paths before download; archive formatting/streaming correctness remains the finance agent's packet.

Regression coverage authored: actual Supabase SDK with a fake transport (zero network on rejected canonical/foreign paths, batch and move/copy cases); DB ingress rejects before any DB interaction; real CSV worker refuses invalid queued references before Storage/progress/writes/child jobs. Existing worker mock names were adjusted to the scoped client; assertions remain intact and import fixture teams are valid UUIDs.

Validation: bounded job `20261103T055323-5279b77ca1` is queued at this checkpoint. No success is claimed until its results are inspected. No live Storage object was read, written or deleted for these tests. This packet is committed now to make the shared guard importable by parallel implementation branches.

### First coordinated validation result

Job `20261103T055323-5279b77ca1` completed 2026-11-03 06:05 UTC. Storage/DB ingress **38/38**, inbox worker **10/10**, invoice delivery worker **58/58** passed. CSV import **15 passed / 1 failed**: the fixture was converted to a canonical UUID, but one expected legacy ID retained `team-1`; the exact expectation is corrected while retaining the same legacy hash and occurrence assertions. Targeted Biome fixed 27 files. Utils and DB typechecks passed. Supabase typecheck exposed two local TypeScript issues (unknown SDK factory result and heterogeneous thenable test callbacks); both were corrected explicitly. API/worker typechecks hit the Node 2 GB heap limit rather than reporting source diagnostics; repeat with a bounded 4 GB Node heap is required.

The new owner regression harness used a nonexistent registry alias for `updateTeamById`; it now asserts the actual `mocks.updateTeam` handler. App/bank mutation handlers are exposed as tracked mocks so zero-write assertions execute; assertion coverage is retained. New DB ingress helper exports are represented in the general API test harness. These fixture/type fixes need the coordinated repeat run, and are not reported as passed yet.

## Assistant request boundary (CODE-06)

Added an explicit `chat.write` scope, verified credential provenance, scope checks before parsing/files/tools, separate `inbox.write` for uploads, and `AI_NOT_CONFIGURED` 503 before work when the instance has no OpenAI key. API-key/OAuth callers cannot inherit a user's personal Composio credentials. Interactive session provenance is explicit. Request size/message count are bounded and malformed bodies return a client error. Authenticated scopes still govern individual MCP tools. HTTP-route regressions exercise denied/read-only/malformed/missing-config requests with zero IO and verify credential provenance. Runtime suite pending the combined queue. AI operation approval remains the next packet; this request boundary alone does not claim to enforce confirmation of financial mutations.

## Bank consent containment (CODE-04)

Existing account discovery requires a local connection ID, current owner role and a primary DB lookup; supplied raw provider references/tokens are ignored. The public bank-connection response keeps the deprecated token field as null. Hybrid internal/browser procedures now enforce authoritative membership/MFA for the browser branch.

New link/exchange/create/reconnect/add-account paths fail closed until a persisted verified consent lifecycle is implemented. Capability readiness includes this gate and remains false even with provider keys present. Manual accounts/CSV remain usable. This is a **mitigation and acceptance gap**, not a completed banking integration. A future replacement must bind provider/user/team/browser state, nonce, TTL, single consumption and exact selected accounts before enabling the capability. Native workers receive local `connectionId` plus `teamId`, never a browser-chosen provider credential.

Migration `20261103091000_bank_browser_reconnect_boundary.sql` revokes browser updates to provider references/expiry and direct credential-table grants. The immutable baseline is unchanged; fresh provisioning must apply incremental upgrades after it. Read-only SQL privilege assertions are in `packages/db/self-hosted/tests/bank-reference-privileges.sql`. HTTP/tRPC regressions cover raw/foreign IDs, server credential use, blocked mutation bypasses and public-token absence. All new tests and migration application remain pending the combined isolated queue.

## Immutable receipt objects (CODE-18)

Bot and Slack ingestion now allocate a fresh UUID object version with `upsert:false`; original filenames are display metadata. Source reference digests bind team/platform/user so the global inbox reference index cannot collide across tenants. When a retry finds an existing row, newly uploaded duplicate bytes are removed and extraction uses the persisted original path, preventing replacement of a prior receipt with different bytes. A failed duplicate-object cleanup is logged without payload data; retention/reconciliation of failed pre-row uploads is still an operational acceptance concern.

New path/reference tests and actual bot-flow tests with a scoped Storage fake check same-name independent uploads, immutable original bytes, retry cleanup, stable original extraction and namespace validation. They forbid live network and preserve exact byte assertions. Runtime validation pending combined queue.

## Diagnostic minimization (CODE-27)

The shared logger emits allowlisted operational metadata rather than arbitrary nested request/job objects. tRPC no longer attaches raw input to Sentry; worker payload reports contain a safe summary and invalid CSV diagnostics report counts. API/worker Sentry disables default PII/console log forwarding and scrubs requests, headers/cookies, raw exception values, breadcrumbs, stack locals and unreviewed context before events or traces leave the service. Exception locations, operational IDs, counts and status codes remain available. Logger text redacts common tokens, email addresses and URL queries; this is not a claim to classify every arbitrary free-form console message in the whole repository.

Synthetic-marker tests exercise the actual logger adapter sink and telemetry sanitizer, asserting that private nested values do not leave the boundary while IDs/counts/source locations remain. Runtime validation pending combined queue.


## CODE05 — durable native integration OAuth (2026-11-03)

Implemented browser-bound PostgreSQL intents for Xero, QuickBooks, Fortnox, Slack and Stripe Connect. Authenticated interactive POST issues opaque state and HttpOnly callback-scoped nonce; only their digests are stored. Intent lifetime is ten minutes. Legacy encrypted state is rejected. Current owner membership and account deletion state are checked under the membership locks at issue, atomic consume, and final persistence. Authoritative MFA is checked before consume and again after provider HTTP. Completion marker and integration write share the same SQL transaction. A second callback cannot exchange the code or overwrite an integration. Callback and dashboard origins must be configured on this instance; no upstream origin fallback is used in the new flow.

Credentialed CORS is limited to the explicit start endpoints; dashboard OAuth hook now uses POST and credentials for each native provider. Slack uses the same durable state instead of trusting installer metadata. Stripe REST disconnect additionally requires an interactive current owner (the durable external revocation workflow is tracked separately in CODE14).

Added integration-oauth.test.ts HTTP boundary regressions (9 cases) and integration-oauth-postgres.test.ts concurrency/rollback/ownership/expiry tests (7 cases). No provider calls or messages were performed. These tests and migration must run in the root-coordinated isolated gate before claiming validation. Pending scope: generic provider revocation recovery after external ambiguous outcomes remains CODE14; native banking consents remain explicitly disabled until their lifecycle is implemented.

CHECKPOINT: source packet complete; verification pending root queue. Next: CODE07 persisted assistant approvals with immutable invoice/recipient revision and manual dashboard approval UI; finance revision API f675657252e1e9004e6e1f8d313a46b1fbc9dee8 is an integration dependency.


## CODE07 — manual assistant action approvals (2026-11-03)

Implemented a vertical slice for invoice send/delete: the assistant can create only a saved proposal, never execute the underlying mutation. Proposals contain the exact invoice version, amount/currency/status, To/BCC/Reply-to recipients and expiry. They bind the verified browser session, actor and tenant. The dashboard loads proposals from the authenticated server endpoint, not tool results or chat history; approval/rejection is a separate explicit button action. Model-supplied consent text, fabricated history and extra approval fields do not authorize execution.

An approval transaction rechecks active Auth session and current membership, locks its one-use row, executes the finance command with expectedRevision, and saves the receipt in the same commit. Concurrent requests and retries return the existing receipt. Stale revisions/expiry/rejection do not execute. Finance issueInvoice freezes recipients into durable generate/email payloads. Pending proposals are capped at ten per actor/team and expire in ten minutes.

Internal assistant runtime now builds from the current scoped MCP definitions and exposes explicitly read-only tools plus the two proposal adapters. Direct unsafe write tools and unrestricted Composio meta-execution are excluded; additional write workflows use their dashboard UI until action-specific approval adapters exist. The shared bot runtime has no browser session and receives read-only tools. Direct authorized MCP clients retain their explicit delegated write scopes.

Added five tool-policy regressions, three HTTP approval-boundary regressions and seven PostgreSQL concurrency/rollback/TTL/session/ownership/budget regressions. Tests pending root queue. Integration dependencies: finance f675657252e1e9004e6e1f8d313a46b1fbc9dee8 and its parent chain; root UI10 Session.sessionId plus private.auth_session_active migration20261103071000 (root reserved timestamp071000). This branch alone does not yet contain those shared APIs. No live emails, OAuth, payment or deletion actions were performed.

CHECKPOINT: source implementation committed for integrated validation. Next assigned work: durable provider revoke and tenant/user/file deletion, security audit journal, resource admission/budgets and QA06. Native banking real consent lifecycle remains pending; existing guard intentionally prevents unverified consent creation.
