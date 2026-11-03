# Resource lifecycle, security history and admission

## Contract

Code packet: CODE14, CODE15, CODE19/QA06, CODE32. Source implementation is prepared; acceptance depends on the combined PostgreSQL/Redis/API/worker gate. No production revocations or deletions were executed during implementation.

Local disconnection and external revocation are different states. `resource_cleanups` retains an encrypted, identity-bound target in the same transaction that removes access/source metadata. It has no parent foreign key. A native worker claims at most five rows, performs bounded requests outside SQL locks, and conditionally records the result using a dispatch token. Completing a row erases its encrypted payload. A two-minute interrupted provider claim becomes `unknown`; it is not blindly repeated. Definite temporary failures retry at most eight times. Storage progresses in batches of 100 and remains pending until the scoped inventory is empty.

Native adapters implement Google token revocation, Slack token revocation, QuickBooks revocation, Stripe Connect deauthorization, and Xero single-organisation connection deletion. Xero refresh-token revocation would affect unrelated organisations, so it is deliberately not used. Microsoft/Fortnox and providers lacking a verified granular revoke endpoint retain a `manual_required` operation. Unknown/partial outcomes require external verification with a non-personal evidence reference. They are not reported as successful revocation.

Composio entities are `agsaas-team-<team UUID>`, never a global user ID. A durable connector reservation precedes authorization; reservation and audit are committed after fresh user/team owner checks under their membership locks. Late activation also checks the original reservation actor under those locks and cannot revive a demoted/departed owner or a disconnecting reservation; repeated pending/unknown attempts do not start a second authorization. The callback URL is pinned to this installation. Fresh provider data is associated only with the matching team's pending reservation. Disconnection hides access immediately, retains the entity/account IDs, revokes upstream tokens, and then deletes the provider connection. Quota is released only after completion. A provider response that confirms fewer token subjects than required is a manual reconciliation. Legacy global-user Composio accounts are not automatically reassigned to a guessed team; inventory and explicit reconciliation are required before enabling such a previously used installation.

Team/user deletion captures storage prefixes, provider connections, subscription identifiers, Auth cleanup, optional configured marketing-contact cleanup, and explicit retention review before removing the parent. Support PII is purged through `private.purge_support_subject`, a private backend-only function; no broad browser DELETE grant is added. A failed Auth request leaves a deletion marker and a durable retry target. Retention review includes backups, object versions, legal/billing records, historical queued payloads/logs, and legacy unscoped assets. Historical signed URLs remain usable until their object is deleted or their original lifetime expires; accepting a cleanup request is not a claim that these prior links already stopped working. A successful Storage API deletion alone does not establish their erasure.

File deletion retains a canonical Vault path and a hash tombstone before removing metadata. Metadata reconciliation cannot recreate a tombstoned document. Service-role Storage writes also check a live team/profile under a key-share lock, so an upload cannot commit after its owning team/account is deleted. The worker has a delete-only Storage capability for the agreed Vault, avatar and app-image namespaces; it does not receive arbitrary read/list/upload access.

## Security history

`appendSecurityAuditEvent(tx, {teamId: string|null, actorUserId?: string|null, operation, targetType, targetId, metadata?})` is transaction-compatible. Allowed metadata is strictly enumerated (scope changes, setting identifiers, status/reason, counts); no credentials, email addresses, request bodies or free-text payloads are stored. The ordinary backend role has SELECT/INSERT, without UPDATE/DELETE. Team owners read their team's journal, and every authenticated user can read their own account-wide events even when the selected team is one they do not own. A nonowner receives only the personal scope; unexpected authorization failures are not treated as permission grants.

API-key create/update/delete, app connects/settings/disconnects, role changes/removals, deletions and cleanup state changes append in the same transaction. Session revocation in the root UI10 packet must call the helper in the same primary transaction as `revokeAuthSessions`. Mount `<SecurityHistory />` from `@/components/security-history` on the account security page after `<AccountSessions />`.

## Admission and resource limits

The shared PostgreSQL request budget admits 600 units/minute per user and 2400 per team. Reads cost one, ordinary mutations five, and expensive import/export/process/sync/chat calls twenty. It is independent of paid-plan entitlements. Database admission failure returns 503; exhaustion returns 429 and `Retry-After: 60` for HTTP. The root file-access guard must call `admitFileRequest(c,{userId,teamId})` after the file identity, session, MFA and ownership checks in both return branches, before Storage IO. It shares a request budget only when the ordinary middleware marker has the exact same user and team; another file-key team/user receives its own debit.

Queue payloads are limited to 5 MiB. Redis atomically limits ordinary queued jobs to 160 per team / 1600 globally, reserving continuation headroom up to 200 / 2000 for classification and email work. Tickets have no silent TTL. Completion/final failure releases them; a bounded minute reconciler releases only actual completed/failed jobs after ten minutes. Missing, unknown, delayed, active and waiting jobs remain reserved. A suspended producer may still enqueue a missing job, so elapsed time is not a release condition. Direct trusted scheduler dispatch is separately batch-bounded and still subject to applicable leaf execution admission. `inspectQueuedReservations()` exposes at most 100 reservation identities/states without payloads. For a missing reservation, stop and confirm termination of every producer that could enqueue that queue, ensure buffered Redis writes cannot resume, inspect the queue again, retain an operational evidence reference, and only then call the backend-only `releaseQueuedJob(queueName,id,teamId)`. Do not automatically clear missing reservations or retry failed jobs outside `triggerJob` admission.

Leaf-heavy jobs have persistent active tickets: four globally, two per team, one per actor where present. The admission transaction is short and no database connection is held while work runs. Tickets are released only after the work promise settles. They do not expire on a broken connection or worker crash. `process-document` is excluded as an orchestrating parent because it waits for classification children; holding its ticket would deadlock child admission. The root parser isolation packet additionally limits child processes and kills/joins them on deadline. A parser-only stage can call `withHeavyJobAdmission` with a stable job key and worker-run UUID, provided its promise settles only after the child has exited.

After a hard crash, inspect `public.heavy_job_admissions` (IDs/team/worker-run/start time only). Confirm the corresponding worker process is stopped before invoking the backend-only `reconcileStoppedWorkerAdmissions(db,{ownerRunId,evidenceReference})` utility. This is intentionally not exposed to a browser or MCP. The operation and evidence reference are persisted. Never release a ticket just because its start time is old; a paused/partitioned worker may still be running.

Input caps: exports <=10,000 transaction IDs; CSV inline <=10,000 rows with <=100 bounded columns; AI mapping <=20 sample rows; document/inbox processing <=20 files per request; bulk inbox deletion <=100; signed URL batches <=100 and lifetime <=300 seconds. Chat accepts <=100,000 UTF-8 text bytes, <=500 parts, <=5 valid base64 attachments, <=5 MiB/file and <=10 MiB decoded total before decoding or Storage/AI work. Root CODE29 owns archive/image/parser preflight and process cancellation; finance owns streaming export format/manifest bounds.

## Migration/dependency order

Apply all committed incremental migrations atomically, in filename order. This packet adds `20261103094000_security_audit_events.sql`, `20261103095000_resource_cleanups.sql`, `20261103100000_resource_admission.sql`. Root support070000/session071000 and infra Storage093100 must be present. Runtime also requires finance `team-entitlements` helpers and migration101000; the cleanup query snapshots connector reservations before team cascade. CODE04's native consent onboarding remains a separate unfinished flow; its fail-closed capability gate must remain until that lifecycle is implemented and accepted.

## Validation status and exact remaining gate

Local offline verification: 46 boundary unit tests passed through the installed Babel transform, exercising the real function bodies with explicit fake transports; syntax parsing covered 66 TypeScript/TSX files with zero errors at that snapshot. The apply/preflight harness also passed 13 preservation/conflict-refusal tests. Reports and reproducible harnesses accompany the delivery packet. These results do not replace Bun suites, TypeScript semantic checks, PostgreSQL/Redis integration, or live acceptance. No external requests or database connections were made by that harness.

For the remaining integration validation, use the shared bounded `imon-job` queue and disposable databases only. Run suites in separate Bun processes to prevent `mock.module` leakage.

Pure API auth/business suites may preload `apps/api/src/__tests__/unit-resource-admission.ts`. This test-only file replaces the independent resource-admission boundary without modifying production behavior. **Do not preload it** for `apps/api/src/__tests__/auth/resource-admission.test.ts` or any PostgreSQL/Redis admission suite. It is optional/unnecessary for the pure chat budget and connector tenant helpers.

New suites:

- `packages/db/src/test/security-audit.test.ts` (2)
- `packages/db/src/test/security-audit-postgres.test.ts` (3)
- `packages/db/src/test/resource-cleanups-postgres.test.ts` (5)
- `packages/db/src/test/resource-deletion-postgres.test.ts` (3)
- `packages/db/src/test/resource-admission-postgres.test.ts` (4)
- `packages/supabase/src/utils/cleanup-storage.test.ts` (3)
- `packages/job-client/src/resource-admission-reconcile.test.ts` (3, fake queue only; separate process)
- `packages/job-client/src/resource-admission.test.ts` (1, local non-default `TEST_REDIS_URL` database)
- `apps/worker/src/utils/resource-cleanup.test.ts` (4, fake fetch only)
- `apps/api/src/__tests__/chat/request-budget.test.ts` (4)
- `apps/api/src/__tests__/auth/resource-admission.test.ts` (7)
- `apps/api/src/__tests__/auth/connector-tenant.test.ts` (2)
- `apps/api/src/__tests__/auth/connector-authorization.test.ts` (4)
- `apps/api/src/__tests__/auth/security-audit-scope.test.ts` (4)

Combined regression set must also include earlier owner-procedures, OAuth state/intent, chat-scope and manual-approval suites, existing team-membership and financial-retention suites, inbox/import/worker boundary suites, and root/finance/infra gates. Typecheck DB, Supabase, job-client, API, worker and dashboard with `NODE_OPTIONS=--max-old-space-size=4096` inside the bounded job; run targeted Biome formatting/lint and `git diff --check`. Tests have not been weakened to accept leaked credentials or missing ownership checks.

Provider protocol references used while implementing offline adapters: [Google revoke](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke), [Xero tenants](https://developer.xero.com/documentation/guides/oauth2/tenants/), [Intuit OAuth](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0), [Composio revoke semantics](https://docs.composio.dev/reference/changelog), [Composio delete](https://docs.composio.dev/reference/v3/api-reference/connected-accounts/deleteConnectedAccountsByNanoid). No external provider mutation was executed.
