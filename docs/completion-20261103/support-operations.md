# Own support queue

Website submissions are accepted by the API only with a separate server-side
AGSAAS_SUPPORT_INGEST_KEY (at least 32 random characters), never a browser key.
The dashboard uses the authenticated support.submit operation. Both commit into
public.support_requests before returning a receipt. A retry retains its UUID;
a different payload or owner cannot reuse that UUID. Admission is serialized
across replicas (10/hour and 30/day per sender, 1000/day total).
The response confirms durable receipt, not email delivery or resolution.

Operators inspect received/in_progress rows through the restricted database
administration channel. Never expose the table through public Data API; browser
roles have no grants. The status change must be made by the designated operator,
after checking the request UUID and actual resolution. No notification or reply
is sent automatically. Retain only as long as the operator's approved privacy
policy permits; whole-instance backups include the table.

Acceptance: real PostgreSQL concurrent replay, conflict, rate-limit and tenant
isolation tests; malformed/oversized/unauthorized HTTP; text preserved on browser
network error. Operator response delivery and final retention require the
operator's accepted contact/process, and are not asserted by the receipt.
