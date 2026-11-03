# CODE-31A, CODE-31B, UI-09 and QA-03 source packet

## Contract

Confirmed money is an append-only journal. Entries are exact positive integer strings in the same currency unit representation used by the invoice/payment boundary, including its documented Stripe ISK/UGX compatibility units. Numeric invoice storage remains numeric(10,2); this change does not invent unsupported extra invoice precision. Every refund names its original payment; reversals name both the refund and original payment. Net refunds cannot exceed that payment. Cached balances and invoice status commit with the entry under an invoice row lock. Paid means net received is at least the invoice total. Excess is an explicit overpayment, never a silent credit note. A full refund has its own refunded lifecycle; it does not automatically start another charge.

A manual entry means the owner explicitly confirmed money already received or returned outside Stripe. The form does not transfer funds. The existing Mark paid operation records the remaining amount through the same journal and stable operation identity, including REST and MCP callers of the existing command. Arbitrary status=refunded edits are rejected; refunds must reference evidence. Legacy paid/refunded records without journal history are displayed as requiring evidence and are not backfilled with invented entries. Historical recorded paid totals remain readable.

The immutable invoice document remains the original billed amount. Settlement history, net receipts, outstanding balance and overpayment are separate. Customer aggregates use actual journal receipts and collectible balances when present; Top Paying Client ranks net recorded cash flow during the last 30 days, in one reporting currency. Unpaid billed amounts are not receipts. Missing FX prevents a plausible incomplete total. Active client time uses the existing floor-to-whole-minute formatter and explains its ranking score.

## Provider attempts and reconciliation

Unresolved Stripe checkout attempts retain the durable provider request identity and replay bound. After confirmed settlement, their original account, amount and PaymentIntent remain in history. A new attempt charges only the current remaining balance. Active unresolved attempts block external manual money recording, preventing a parallel checkout from using an obsolete balance. Historical webhooks do not overwrite a newer attempt. Signature validation is followed by invoice/team/original-account/attempt/exact-amount checks.

Refund webhooks retrieve the complete bounded current provider refund list and forward individual IDs/status/amounts. Pending refunds have no monetary effect. Succeeded refunds append once. A later failed/canceled refund appends a compensating reversal once. Missing or contradictory previous evidence is rejected for reconciliation, never erased. API provider refund action still requests the remaining full refund of the current Stripe payment; arbitrary partial Stripe refund initiation is not introduced. Partial refunds initiated at Stripe and confirmed external manual refunds are supported by the journal. Provider sandbox/end-to-end acceptance remains required; no live payment was performed.

The owner reconciliation endpoint rebuilds derived balances from immutable entries and cannot fabricate legacy evidence. Direct journal UPDATE/DELETE is blocked by SQL and runtime grants. Existing explicit invoice/team deletion cascades and actor anonymization cascades retain their previous erasure behavior; this is an engineering retention boundary, not a jurisdiction-specific legal retention claim.

Polar now handles complete updated and uncanceled resources, including supported terminal/incomplete states without retaining a paid entitlement. Existing own-product/customer/team and resource-version checks remain. Repeated past-due metadata does not create repeated notices. Owner reconciliation reads only the stored subscription ID via SDK GET outside SQL, then compares the binding again under the team lock, preventing a response for a replaced subscription from restoring it. Missing bindings and unknown states require investigation; no email-based account discovery is performed.

## Independent scenario ledger

| Scenario | Expected money/status |
|---|---|
| Invoice 100; confirmed payments 40 and 60 | received 100, remaining 0, paid |
| Refund 15 from a confirmed payment | net 85, remaining 15, unpaid |
| Two simultaneous refunds of 70 from payment 100 | exactly one succeeds; refunded 70, net 30, remaining 70 |
| Payments 40 and 60; refund 40.01 against first payment | reject; refundable limit is 40, not aggregate 100 |
| Invoice 100; payment 110 | remaining 0, overpayment 10, paid |
| Full refund 100; reversal 25 | net 25, refunded 75, remaining 75 |
| Manual 40; Stripe remaining 60; refund 15; second Stripe attempt 15 | total received 115, refunded 15, net 100, paid |
| Pending Stripe refund 20 | net remains 100 |
| Confirmed refund 20 later fails | append one reversal, net returns to 100; replay adds no entry |
| Failure before outer commit | no journal row, no changed status/snapshot, no PDF dispatch |
| Foreign invoice, original payment or currency | reject before financial mutation |
| Derived cache drift | dry-run detects; apply repairs cache/status only; entry count unchanged |
| Partial payment between AI preview and accept | revision changes even when status remains unpaid |
| Legacy paid marker without evidence | reconciliation required; no synthetic payment created |
| Unpaid invoice 100 | Top Paying Client receives no revenue from it |
| Confirmed partial 40 on invoice 100 | customer receipts 40; outstanding summary 60 |

## Verification status and required gate

This packet is IMPLEMENTED SOURCE PACKET, NOT ACCEPTED. New ledger/Polar/UI scenarios, API authorization negatives, provider mocks and SQL concurrency/fault cases are written but not yet run. Parent owns one combined imon-job after integration. Use scripts/verify-finance-ledger.sh with the private TEST_DATABASE_URL for the guarded isolated midday_test database. The helper applies migration 20261103065000 only there; no production migrations ran. The packet requires Bun 1.3.11 frozen dependencies, workbench build and NODE_OPTIONS=--max-old-space-size=4096. API provider mock suites run separately to avoid module contamination. UI browser checks and real own-provider sandbox acceptance remain pending.

Main packet prior evidence: worker/dashboard typechecks passed. Export/report/client-activity PostgreSQL suites passed; the final two invoice assertions were corrected at 2609602. Last combined job 20261103T065220-20e8286af3 never started tests because a sudo source guard was denied by imon-job NoNewPrivileges. Wrapper corrected to unprivileged git safe.directory; no access-control changes. Main API/DB typecheck fixes and final repeats remain pending the merged gate.

Remaining provider operation boundaries: an expired unknown Stripe create with no persisted provider ID cannot be retried safely and continues to require operator/provider evidence. The new ledger reconciler repairs derived state from known immutable entries; it does not discover unknown provider requests or invent confirmations. New manual entries are owner-gated, while the existing Mark paid route retains its pre-existing authenticated-team policy. The retained legacy paid reporting fallback is a recorded historical status, not newly verified provider evidence. Full Stripe refund initiation still targets the current payment; selecting arbitrary historical payments and initiating partial Stripe refunds remain additional workflow work. No jurisdiction-specific credit-note/tax-document contract is introduced.
