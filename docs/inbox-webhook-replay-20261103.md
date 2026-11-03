# Postmark attachment receipt recovery (CODE09)

## Durable handoff

Each delivery slot has a team-scoped reference derived from the Postmark MessageID
and its original attachment index. The content SHA-256, original name, MIME and
ContentID are retained separately as immutable input assertions. Changing the
bytes or metadata for the same source slot is a conflict, not a new receipt.

The object key is `<team>/inbox/uploads/receipt_<SHA-256>.bin`. The fixed suffix
prevents a concurrent MIME change from selecting a second object key. The
original MIME and filename remain in Storage/Inbox metadata and the worker
payload. Filenames never become path segments. This matches the actual
`private.vault_key_team`, `guard_live_storage_object` and `requireVaultPathForTeam`
contracts: they require canonical tokens and a UUID team segment, not a UUID leaf.

Storage uploads use `upsert: false`. An existing object or lost upload response is
accepted only after reading and hashing the exact expected bytes. No receipt
object is overwritten or removed during replay. Storage's transactional document
projection and its existing reconciler continue to own Vault metadata.

`createInbox` registration happens on the primary database before queue submission.
The row returned by the authoritative reference lookup, including conflicts, owns
the processing path, MIME, size and sender. A crash after upload or after commit
can be retried against the same object and row. New and processing rows wake the
same stable BullMQ job; processed, manual-review and deleted rows are not revived
after queue retention expires.

Historical global references are looked up with an explicit team predicate. Their
old canonical path and bytes must match before adoption. An ambiguous same-name
legacy attachment or unavailable legacy object needs operator reconciliation; the
handler never guesses or creates a second apparently successful document.

## Queue recovery and HTTP behavior

The separate admission generation packet is a dependency. Retained failed jobs
use its pinned native atomic retry and exact failed-attempt snapshot, never
remove/recreate or an unguarded `Job.retry()`. Live handoff also requires a valid
admission record: a queued native job with a pending/unknown marker is not a
successful acknowledgment. A completed queue receipt requires a committed Inbox
processing outcome.

Attachment operations run with concurrency four and `Promise.allSettled`.
Successful partial work is preserved. Any upload, verification, registration or
queue failure returns HTTP **503**, `success: false` and attempted/accepted/failed
counts. All success returns 200. Invalid bytes or bounded input metadata return
400 before any attachment side effect. The request body is limited to 70 MiB,
decoded attachments to 50 MiB, and attachment count to 100.

Postmark documents that inbound deliveries without a 200 response are retried;
403 stops retries. See its official
[inbound retry guide](https://postmarkapp.com/support/article/understanding-inbound-webhook-retries-in-postmark).
The existing IP and Basic Authentication boundaries are unchanged.

Notifications remain a non-critical side effect and use a stable message job ID.
This is not a permanent exactly-once notification outbox: a very late replay after
notification job eviction may send another notice. It cannot create another
receipt object or Inbox row.

## Verification scope

The service tests use fake Storage, authoritative receipt maps and a fake queue to
exercise simultaneous replay, same-name attachments, tenant scope, payload drift,
lost responses at each handoff, partial/all failure, legacy adoption, retained job
failure and completed/deleted states. HTTP tests run the real Hono route and
ingestion service with fake external boundaries and verify 503/200/400/403 behavior.
The separate real Redis admission gate is required for native queue race evidence.

No migration or production data is changed by this packet. Own Auth/Storage
service acceptance, real Postmark delivery, and browser receipt review remain
integration gates; a fake Storage test does not establish those outcomes.
