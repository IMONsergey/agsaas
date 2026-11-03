# Durable invoice refund requests — source contract, 2026-11-03

## Problem and scope

The previous remaining-full-refund route sent a provider POST without first retaining a request. Its invoice/payment-derived key could be reused after the provider's retention window. A crash after the external side effect could therefore lose both the provider resource ID and a safe retry age. A pending or unknown refund also lacked a durable row independent of cached journal projections.

This change adds one append-only migration, `20261103110000_invoice_refund_requests.sql`, and an owner-authorized request/resume service. The UI still requests the exact remaining full refund of the current original Stripe payment; it does not add partial-refund selection.

## Request and authorization contract

An invoice row lock serializes preparation against invoice edits, payment reservations, manual settlement and other refund requests. The current owner is locked first. The retained row binds the original invoice, tenant, payment journal entry, connected account, payment intent, payment amount, exact refundable amount, currency, client operation UUID, request hash and provider idempotency key. There is one unresolved request per invoice and one row for each tenant/operation UUID. Repeating an operation returns the same row without modifying its creation time or financial identity.

The provider payload always includes an explicit amount and metadata `invoice_id`, `team_id`, `invoice_refund_request_id`. The key is `invoice-refund/<request UUID>/v2`. The client cannot supply an account, amount, actor, provider resource, proof or revision. `refundPayment` requires an operation UUID; `resumeRefundRequest` requires the existing request UUID.

No SQL lock spans HTTP. A short dispatch transaction rechecks current ownership, invoice/journal/request revision, request hash, absence of another unresolved payment or settlement marker, and the database replay window. It commits an `unknown` state and a bounded exclusive claim before the POST. This commit is the authorization linearization point: demotion during preflight prevents dispatch; demotion after dispatch cannot retract bytes already sent to a provider. A late receipt is still retained after demotion, while owner acknowledgment and financial apply require the current owner again.

## Retry and uncertainty contract

The request's immutable creation time bounds POST replay to less than 23 hours. Both application logic and SQL guards use the database clock. `created_at`, financial bindings, provider key and first attempt are immutable; subsequent attempts cannot move backward or extend the original window. A backwards clock or expired window blocks POST. The per-request timeout also subtracts claim round-trip time and cannot exceed the remaining safe window. Stripe automatic network retries are disabled at route construction.

Timeout, network failure, 4xx, 5xx, receipt-persistence failure and process death do not prove that an earlier POST had no effect. They retain `unknown`, never `failed`. Inside the safe window, an unknown request can repeat only the same key and same payload. An active lease refuses concurrent dispatch and remains retained after a timeout. A new attempt must use a new claim token; an old worker cannot clear a newer claim. A process restart does not reset any age or identity. An expired request remains fenced and can still recover through positive evidence.

A known provider refund ID always uses GET; it never falls back to list/create on a missing resource. A lost ID can be recovered only from a complete bounded refund discovery followed by an exact resource GET whose metadata, amount, currency and original payment match this retained request. Empty or partial discovery is never proof that an unknown POST was absent. Unknown/null statuses retain uncertainty and, when available, the provider ID.

## Accounting and reconciliation

A POST acknowledgment retains a provider ID and binding but is not journal money. Exact GET or the existing authorized webhook adapter can confirm a succeeded refund. Pending and requires_action remain bound and block further money operations. Failed/canceled exact GET can close an uncompleted intent, but cannot manufacture a reversal of an existing journal refund. The existing full provider reconciliation still requires its exact failure-balance evidence for reversal.

Manual/outside payments and refunds, new online checkout, Mark paid, new refund preparation, projection repair and journal-only provider reconciliation all respect active refund intents. Persisting/replaying a cached projection cannot erase the independent request row. An unknown create without an ID cannot be cleared by proving only the set of older known journal resources.

The final apply checks a full invoice/journal/marker/request revision under the invoice lock and a current owner. Concurrent events make the old proof stale. Retaining a useful provider ID is allowed after that race, but financial apply waits for a new proof. Completing this request never removes an unrelated durable settlement marker. A contradiction of a terminal provider outcome, including a later pending observation for a failed request without a journal refund, creates a durable reconciliation marker. The implementation deliberately does not guess a compensating journal entry or treat that contradiction as absence.

## Schema and retention boundaries

The schema uses constrained states `reserved`, `unknown`, `bound`, `settled`, `failed`, `manual_unknown`. Provider ID is write-once; a verified binding cannot be forgotten. A claim is allowed only on an unbound unknown request, is at most 30 seconds, and cannot be extended without a new valid attempt. Terminal transition requires an already retained bound identity; settled additionally requires the exact refund journal entry in the same transaction. External GET proof is verified by the authorized service, since SQL cannot independently establish an HTTP fact. Terminal state/status cannot be rewritten to reopen dispatch. Guards reject backdating an attempt after the real database replay deadline.

Direct request deletion is forbidden. Parent invoice/team deletion may cascade only terminal settled/failed rows; an unresolved provider effect cannot disappear through account deletion. `actor_id` may be nulled only by its legitimate profile FK action. Backend access is explicitly granted to `agsaas_app`; public/Auth/Storage clients do not gain access. Team export includes the retained request and outcome but excludes idempotency key and claim token.

No legacy refund is guessed or backfilled. Existing unknown Stripe payment reservations and prior manual_unknown settlement markers remain unresolved until their original evidence is reconciled.

## Primary provider sources and assumptions

Checked against installed Stripe 20.4.1 types and Stripe's API v1 documentation. The SDK allows `Refund.status: string | null`; treating its type as an exhaustive enum would be unsafe.

- https://docs.stripe.com/api/idempotent_requests — keys can be pruned after at least 24 hours; cached results include failures after request execution begins; changed parameters cannot reuse the same key safely. Our bound is stricter at 23 hours.
- https://docs.stripe.com/error-low-level — network/5xx outcomes can be indeterminate; retain keys across process restarts and use local metadata identifiers for recovery.
- https://docs.stripe.com/api/refunds/create — explicit amount is in the smallest currency unit and is limited by the original refundable amount.
- https://docs.stripe.com/api/refunds/object and https://docs.stripe.com/api/refunds/retrieve — inspect the current exact refund resource, including asynchronous states, original payment, amount, currency and metadata.
- https://docs.stripe.com/webhooks — deliveries can be duplicated or arrive out of order. A notification does not replace a fresh resource proof.

No real Stripe request, payment, email or other provider side effect was performed during development.

## Review and validation status

This file records a source implementation, not a runtime acceptance claim. Source syntax/format/diff evidence belongs to the package receipt. Runtime validation must run through the shared `imon-job` queue, using fresh processes and the isolated synthetic full foundation plus this separately reviewed migration.

Targeted suites:

- `packages/db/src/invoice-refund-request.test.ts`: immutable age, exact expiry, backwards clock, known-ID and blocked-state replay refusal.
- `apps/api/src/__tests__/invoice-refund-engine.test.ts`: durable claim before POST, explicit payload, timeout/5xx/4xx uncertainty, lost receipt after POST, known-ID GET only, missing GET refusal, restart/expiry, demotion boundaries, stale proof, unknown statuses and claim-latency budget.
- `apps/api/src/__tests__/trpc/invoice-payments.test.ts`: owner/tenant binding, new request and resume contract, strict caller input, current owner errors, no direct invoice mutation.
- `packages/db/src/test/invoice-refund-requests-postgres.test.ts`: real guards, concurrent operations, atomic intent/audit rollback, money fences, fake-provider recovery, exact GET transitions, late terminal contradiction, owner demotion, stale marker, immutable fields/provider ID, parent-delete retention, actual database expiry and cross-tenant isolation.

Existing settlement, authority, payment, invoice command, export and upgrade suites must be rerun after applying the new SQL. The old chain/lock has not been edited by this lane. Root owns atomic source-lock refresh and the distinct new migration receipt; the earlier synthetic-foundation receipt cannot attest to this new migration.
