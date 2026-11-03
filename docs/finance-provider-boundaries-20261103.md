# Provider uncertainty: adapter and deadline boundaries

This is a separate follow-up to `bd95bcd2671382123c819c8c7aa8799b52c6d381`. No old migration or provider resource is changed.

The webhook observation adapter preserves unknown and null refund statuses until the database has authorized the original account, payment and invoice. The DB then commits an uncertainty marker before returning a conflict. An existing confirmed refund stays in the journal unchanged. A newly observed unknown refund absent from the journal receives `manual_unknown`; checking only older known IDs cannot clear it. Owner verification continues to reject unknown statuses.

The complete-list reader, pagination and exact resource reader now pass a per-request Stripe timeout bounded by the remaining shared 15-second deadline, with a maximum of five seconds. A late response is still rejected after the request returns. The installed Stripe 20.4.1 `RequestOptions.timeout` supports this override.

Required queue checks:

- API `invoice-provider-reconciliation.test.ts`: unknown/null observations reach the DB boundary, only 500 ms remain for the final GET, and a late result is refused.
- API `invoice-refund-request.test.ts` and `invoice-payment-routes.test.ts`: existing complete-list and webhook contracts retain their behavior.
- DB `invoice-settlement-postgres.test.ts`: fake provider observation through the real adapter and PostgreSQL commits both unknown/null markers and blocks manual money, refund requests and checkout; an unknown unjournaled resource cannot clear using the older known journal.
- DB and API typechecks, including the intentional cross-layer integration import in the PostgreSQL suite.

Source parsing and formatting do not establish runtime acceptance. These checks run only through the coordinated isolated queue. No live Stripe request or DDL was executed while preparing this follow-up.
