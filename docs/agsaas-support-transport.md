# Optional support and feedback transport

Support and feedback use two small GraphQL mutations against Plain's official
`https://core-api.uk.plain.com/graphql/v1` endpoint. The deprecated
`@team-plain/typescript-sdk` dependency is removed from the dashboard. Its pinned
v5.12.1 implementation and the official API docs were checked for the request,
input and mutation-output contracts; no live support requests were sent.

`PLAIN_API_KEY` is read only when an authenticated action is invoked. Without it,
both actions report that support messaging is not configured. The existing
support capability gate remains in place. Optional `PLAIN_SUPPORT_LABEL_ID` and
`PLAIN_FEEDBACK_LABEL_ID` belong to the operator's own workspace; unset labels
produce an empty label list. No upstream label ID or custom URL field is needed.
The support product and page context are plain text components.

The current user's stable application ID is the Plain external customer ID.
Editable profile email is contact data and is not asserted to be verified.
Existing customers remain unchanged (`onUpdate: {}`). A pre-existing Plain
customer with the same email but a different external ID may need operator
reconciliation; the application does not silently attach another customer's ID.

Inputs are bounded (subject 200 characters, message/feedback 10,000, email 320,
name 200, URL 2,048), priorities follow Plain's documented 0=Urgent through 3=Low,
and user strings are sent only as GraphQL variables. The transport uses one
eight-second budget across customer upsert, thread creation and response reads;
each response is limited to 64 KiB. Redirects are refused.

HTTP status, GraphQL errors, mutation errors and the actual customer/thread IDs
are checked. Only a confirmed thread ID produces `{ accepted: true }`. A lost,
malformed or incomplete response is reported as unconfirmed, because a thread
may already have been created. There is no automatic retry, delivery outbox or
exactly-once guarantee. Provider errors and credentials are not logged or passed
to the browser. The support UI preserves the message on failure and shows the
safe action error instead of reporting success.

Validation: `bun test apps/dashboard/src/utils/plain-support.test.ts` runs actual
actions and transport with isolated HTTP responses and blocked real network.
It checks exact queries/variables, priorities/own labels, absent configuration,
input limits, HTTP/GraphQL/mutation errors, missing receipts, response size,
timeout propagation and no automatic retry. A real provider lifecycle check
remains an operator task after configuring the service.

Primary references:

- [Pinned SDK request transport](https://github.com/team-plain/typescript-sdk/blob/v5.12.1/src/request.ts)
- [Pinned SDK client operations](https://github.com/team-plain/typescript-sdk/blob/v5.12.1/src/client.ts)
- [Plain GraphQL request contract](https://www.plain.com/docs/graphql/introduction)
- [Customer upsert](https://www.plain.com/docs/graphql/customers/upsert)
- [Thread creation](https://www.plain.com/docs/graphql/threads/create)
- [GraphQL and mutation errors](https://www.plain.com/docs/graphql/error-handling)
- [Numeric priority contract](https://www.plain.com/changelog/customer-feedback)
