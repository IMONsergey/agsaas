# Financial producer admission follow-up — 2026-11-03

This source packet depends on the generation/CAS admission contract from infrastructure commit `4edd072331fa127a02a88416df1e65c8c3de0cfa`.

Four production producers previously called `Queue.add` without `reserveQueuedJob`: the SQL financial outbox dispatcher, scheduled invoice generation, PDF classification after invoice generation, and team insight dispatch. Each now reserves tenant capacity before a new queue write while retaining its original attempts, backoff, delay and receipt retention options.

The SQL outbox keeps its existing `financial-<dispatch UUID>` identity and payload hash checks. It captures an admission generation before reading a queue receipt's state. Only a confirmed terminal state releases that captured generation through CAS; the Redis receipt remains until the caller records SQL completion. An existing active pre-admission receipt is adopted without a second queue add. A terminal legacy receipt does not reserve a new slot. Missing queue acknowledgements, state errors and uncertain admission metadata retain their reservation and SQL recovery source. An `accepted` receipt requires an explicit live state (`waiting`, `active`, `delayed`, `prioritized`, `paused`, or `waiting-children`); `unknown` or unsupported states defer SQL without releasing or adopting a slot.

Scheduled generation includes `teamId` from the authoritative invoice row. Its child ID hashes tenant, invoice and exact schedule marker. Invoice classification hashes tenant, invoice and parent job ID. Retries therefore use the same admission identity. Insights retain the existing tenant/period ID. These producers never release a reservation merely because `Queue.add` threw.

## Verification prepared

- Existing financial outbox tests retain outage, lost acknowledgement, SQL-before-receipt cleanup, retained failure, Redis recreation and schedule assertions. New cases cover admission denial, legacy active adoption, terminal legacy receipts, stale-generation CAS and uncertain state reads.
- Actual scheduled invoice and generation processors run behind fake external boundaries in `invoice-email-delivery.test.ts`. New cases check authoritative tenant binding, admission-before-add, capacity refusal, stable retry IDs and unchanged retry options. Existing email/delivery assertions remain.
- `dispatch-insights.test.ts` exercises the actual dispatch loop with fake DB/queue/admission boundaries, including capacity refusal, stagger/backoff retention and lost acknowledgement identity. The canonical finance script includes it in a fresh Bun process.

Only source formatting, syntax and diff checks are performed by this lane. Unit/runtime/real Redis acceptance must use the root-coordinated shared queue. No provider, email, production Redis or database operation is part of this source packet.
