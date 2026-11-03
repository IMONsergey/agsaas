# Preserve provider uncertainty until the original resources are verified

## Scope and status

This change addresses a confirmed Stripe refund that later disappears from a complete observation, changes its amount, returns to `pending` or `requires_action`, or contradicts an already recorded reversal. The existing implementation threw inside its transaction and lost the reconciliation marker. A later payment replay could also reset the marker while rebuilding the monetary projection.

The source is based on the merged completion snapshot, with the current financial authority and cleanup work retained. No production provider request, payment, refund, email or database migration was executed while preparing this change. Runtime results belong to the coordinated queue receipts; source formatting is not evidence that PostgreSQL or API tests passed.

No new tables or schema migration are required. The current `invoice_settlement_state.reconciliation_required` and `reason` retain the decision, and the immutable journal retains its invoice, account, payment and refund resource bindings.

## Contract

1. An anomalous observation of an already recorded refund commits a durable marker before the adapter returns a conflict. It does not erase a journal entry or manufacture a compensating entry.
2. Projection writes, duplicate payment deliveries, manual receipt replay and ordinary local reconciliation preserve the marker. Each marker write advances `updated_at` by at least one PostgreSQL microsecond even when the balances did not change. Projection writes advance the same revision rather than resetting uncertainty.
3. The backend blocks new manual/outside-provider entries, new online payment reservations and refund requests while the stored marker is present. The existing Mark paid command already checks the settlement fence. The UI disables the corresponding money actions and shows the retained problem.
4. Automatic verification is available only for `stripe_known_refund_requires_reconciliation`. An existing unknown or unrecognized reason cannot be overwritten by a later known-resource anomaly. An unresolved payment creation without a provider ID promotes the marker to `manual_unknown`.
5. An owner can explicitly verify with Stripe. A short first transaction rechecks the current owner, locks the invoice, collects all known Stripe payments and refunds, and captures a revision covering the invoice, journal and marker. Provider GET requests run after this transaction has ended. A final transaction rechecks the owner and the complete revision before making any change.
6. Clearing requires the original connected account, exact PaymentIntent ID, amount, currency and tenant metadata, complete current refund discovery, and an exact GET for each known or newly discovered refund ID. A missing-resource error is not an empty proof. A missing known refund, unknown status, changed amount/account/currency, or stale revision leaves the marker intact.
7. `pending` and `requires_action` do not prove a refund completed or that money returned. A verified `failed` or `canceled` refund that was previously journaled also needs its return-of-funds balance-transaction reference before the application appends one idempotent refund reversal. Previously reversed refunds cannot silently become successful again.
8. An owner cannot clear uncertainty by merely checking an empty or incomplete set of known resources. Any unresolved payment reservation blocks this path. Newly discovered successful or pending refunds must be represented or resolved before the known-history marker can clear. Unknown request outcomes remain a separate manual reconciliation fence.

The provider verification endpoint accepts only the invoice ID and the explicit verification/apply choice. It does not accept caller-provided evidence, tenant identity, revision or provider resource values. Audit attribution uses the authenticated actor and commits atomically with the result. A concurrent demotion or failed audit write cannot acknowledge a successful verification.

## Stripe contract checked on 2026-11-03

Installed `stripe` version: **20.4.1**. Its `Refund.status` declaration is `string | null`, so a TypeScript enum assumption is insufficient; runtime validation must reject unknown and null statuses. The installed `RefundsResource.retrieve` overload accepts the exact refund ID and request options, including the original connected-account scope.

Primary references:

- [Refund object](https://docs.stripe.com/api/refunds/object): the documented statuses are `pending`, `requires_action`, `succeeded`, `failed` and `canceled`. The refund binds its amount, currency and PaymentIntent. `failure_balance_transaction` identifies the adjustment when a refund fails.
- [Refund lifecycle](https://docs.stripe.com/refunds#requires-action): Stripe documents a successful refund returning to `requires_action` when the customer's bank returns the funds. Failed and canceled states have failure information. Therefore the implementation does not treat a prior `succeeded` observation as irreversible, and does not interpret `requires_action` as a completed financial reversal.
- [Retrieve a refund](https://docs.stripe.com/api/refunds/retrieve): a resource lookup uses the refund's exact ID. Lookup failure is retained as failed verification rather than interpreted as proof of absence or cancellation.
- [Webhook ordering](https://docs.stripe.com/webhooks#event-ordering): delivery order is not guaranteed. Event creation timestamps are snapshots with second precision and are not a valid ordering mechanism. A replayed webhook cannot clear this marker.

The application assumption is deliberately narrower than permanent settlement finality: GET proves the observed current resource binding and status, not that the external provider can never change afterward. A subsequent contrary observation creates or refreshes the marker again. Local revision checks prevent a response collected before another committed local observation from clearing the newer marker; they do not claim an atomic transaction with Stripe.

## Bounded IO and failure handling

Verification permits at most 16 known payments and 100 exact refund resource reads, with a shared 15-second processing budget checked between requests. The API Stripe client uses a five-second per-request timeout and no automatic network retries. The existing complete-refund pagination limit remains in force. Exceeding a limit leaves the marker set and requests manual reconciliation; it does not silently truncate evidence.

The webhook adapter obtains exact GET evidence before compensating a previously confirmed failed/canceled refund. If this read fails, the event remains unverified and the database commits uncertainty. If an invoice is already marked uncertain, a webhook cannot independently append a new refund reversal and clear that condition; the owner verification uses the complete revision and resource set.

## Explicitly separate work

The existing refund POST path still needs a durable request intent, persisted provider refund ID, and an age-bounded retry/recovery policy. Its current fixed full-refund idempotency key is not a permanent guarantee across the provider's retention window. This patch does not claim to close that request-creation gap and does not infer an unknown request's outcome from known ledger IDs. Partial refund selection and broader historical-payment UI are also outside this change.

## Required verification

Run these in fresh processes through the coordinated queue, with the guarded isolated PostgreSQL foundation for the database suite:

- `apps/api/src/__tests__/invoice-provider-reconciliation.test.ts`: exact resource/account bindings, omitted known resource, GET error, unknown status, nonterminal status preservation, limits, and late failure-list snapshots.
- `apps/api/src/__tests__/trpc/invoice-settlements.test.ts`: authenticated actor/revision forwarding, member denial, explicit apply, rejected caller proofs, provider failure, and demotion after GET.
- Existing `apps/api/src/__tests__/invoice-payment-routes.test.ts` and refund-request tests: webhook and refund-request compatibility.
- `packages/db/src/test/invoice-settlement-postgres.test.ts`: committed markers, paid replay, local rebuild, blocked new money, unchanged evidence, exact proof recovery, stale proof after a new marker, missing/wrong proof, return-of-funds evidence, already reversed refunds, and unknown request fencing.
- Package typechecks for DB, API, worker and dashboard.

The API mocks remain scoped to API unit processes. The PostgreSQL suite exercises the real transactions, row locks, journal and provider marker without contacting Stripe.
