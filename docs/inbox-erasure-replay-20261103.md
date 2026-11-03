# Inbox erasure and provider replay — 2026-11-03

## Reviewed problem and contract

The pre-existing Inbox deletion command physically removed the row after retaining encrypted file cleanup. The webhook receipt lookup read only that row. A redelivery therefore lost its source identity after deletion. Before byte cleanup, upload conflict plus matching old bytes could allow registration again; after byte cleanup, absence could produce indefinite retries.

This change preserves physical deletion. A separate private ledger records the erased source identity, so provider redelivery cannot create the same Inbox receipt or object again. A successful deleted acknowledgement requires exact retained evidence. Unknown historical evidence remains unsuccessful and cannot be converted into equality by an absent object.

Core checkpoint: af6ee7ce8135cccf067009f4cc4561442d28aa36, based on ae84063c844232e7e6108845fccf96b1a922642e. Follow-up commits contain tests and any peer-review corrections.

## Minimal retained data

The new private.inbox_deletion_receipts table contains team and Inbox UUIDs, a source-reference SHA-256, object-path SHA-256, MIME SHA-256, original byte count, optional content SHA-256, optional metadata SHA-256, creation time and one bounded unavailable-proof reason.

The ledger stores no raw reference, path, filename, sender, subject, OCR result, customer, transaction or monetary data. The existing encrypted cleanup target retains the path until its existing erasure workflow confirms completion. The new ledger is separate from public.inbox and public.documents; ordinary Inbox reads, search, counts and exports obtain no extra Inbox row from it. Monthly admission evidence already retained by team_quota_usage continues to count the original accepted work; replay and the erasure receipt add no new usage.

Canonical Postmark equality uses the original byte hash, byte count, MIME hash and the metadata fields checked by the existing ingestion contract: source, sourceVersion, messageId, attachmentIndex, attachmentContentId, originalFileName and contentSha256. OCR metadata added later is excluded from this digest. Canonical MIME, size and that source metadata cannot subsequently change.

Legacy rows do not possess all original delivery evidence. Their stored source-reference hash and known metadata remain binding. A cleanup worker may retain an exact digest of the bytes still available at the retained object path before erasing them. This proves those observed stored bytes; it does not reconstruct a historical provider payload or an already removed file.

## Transaction and race boundaries

Application create/delete commands use the primary connection and acquire team KEY SHARE, sorted source-reference advisory locks, then sorted object advisory locks before mutable tuple locks. Batch deletion acquires all source locks before any object lock. The selected scope is checked again after the Inbox/document row is locked.

A row trigger can already own a tuple lock. Trigger-side acquisition therefore uses team NOWAIT and nonblocking advisory locks, failing the transaction on an inverted/contended order. Storage metadata writes, document projection, deletion markers and Inbox writes share the object scope. These are source-level ordering rules; actual PostgreSQL race tests provide the runtime evidence. General deadlock freedom for arbitrary caller-owned transactions is not claimed.

Receipt lifecycle writes require READ COMMITTED (or PostgreSQL's equivalent READ UNCOMMITTED behavior). A transaction-wide older snapshot is explicitly refused with SQLSTATE 40001. VOLATILE trigger functions read committed deletion evidence after acquiring their scope. PostgreSQL 16 documents the snapshot distinction:

- https://www.postgresql.org/docs/16/xfunc-volatility.html
- https://www.postgresql.org/docs/16/transaction-iso.html

Receipt lookup reads the active row first, then private evidence on primary. Because physical removal and evidence commit atomically, this ordering avoids a gap when deletion commits between those two reads. A ledger-first lookup would be unsafe. The API checks retained state again after Storage work and after completed queue state; an error is acknowledged only after a fresh, exact deleted-proof check.

Physical row removal and document guards provide the durable output boundary. Worker checks before external work, after extraction, after persistence and before handoff reduce stale work; a zero-row update stops downstream jobs. Already issued external requests cannot be recalled by these checks, and no database lock is held across network IO.

## Legacy proof and erasure

The digest capability is separate from the delete-only Storage client. It uses the installed Storage SDK's download().asStream(), hashes chunks without materializing a Blob, returns only hash/size, validates the retained team/path, rejects redirects and non-200 responses, and bounds reads by the original retained maximum and 50 MiB. One ten-second signal covers the HTTP request and body. Abort cancels a pending stream read.

Only the active exact cleanup lease can save an observation for its immutable team/object binding. The SQL function rechecks clock_timestamp() after obtaining the cleanup tuple lock; a lease that expires while waiting cannot save proof. Known content hashes are write-once. Size mismatch, unavailable download and unverifiable size remain explicit uncertainty.

A failed optional proof read/save does not delay byte removal. Consequently, a crash or missing object can leave proof unknown even after erasure completes. Unknown legacy redelivery remains unsuccessful and cannot resurrect data. An old hard deletion that predates this ledger has no reconstructable source-reference mapping. These cases need an explicit operational resolution; automatic acknowledgement or clearing a marker is deliberately unavailable.

## Public response compatibility

updateInbox(status: "deleted") executes physical erasure and returns:

    { id, deleted: true, status: "deleted", cleanupPending, cleanupId }

REST PATCH advertises and validates the update/erasure response union. REST DELETE also returns the complete erasure receipt. MCP returns the same pending-cleanup evidence for both inbox_update and inbox_delete, preserves the latter's success/deletedId fields, and marks erasure-capable tools as destructive. No former file or transaction fields are returned as a substitute Inbox item. Ordinary updates retain their existing response.

Baseline non-file rows remain supported. New canonical webhook rows require a valid scoped path; supplied paths on new inserts are checked. Existing unchanged legacy NULL/invalid identity can still be updated; NULL-path records can be erased through the normal command. Historical invalid paths retain the existing application scope-validation boundary and require scope reconciliation before file cleanup. The row trigger itself permits physical deletion of legacy rows. Changing a receipt's team/reference/path is refused.

## Migration and execution prerequisites

Append-only SQL: packages/db/self-hosted/upgrades/supabase/migrations/20261103123000_inbox_deletion_receipts.sql

Reviewed SQL SHA-256: 34a73f78d312d6f46e26057ab3c666e9832a6f0096c52b08bdbcd132a42f87b4

Existing migrations and the frozen chain lock are unchanged by this packet. Root/infrastructure must update the chain manifest and apply this new SQL through the separately reviewed shared-queue workflow before deploying these readers/workers. The append2 refund/Plaid runner does not apply this migration.

Source changes were checked with Biome and git diff --check. This document does not claim runtime acceptance. No provider call, database statement, migration, build, dependency install or test execution was performed by the author while preparing this packet.

The PostgreSQL suite requires the reviewed synthetic fixture with 123000 already applied and its sterile MIDDAY_ENCRYPTION_KEY for fixture-only cleanup records. It creates and deletes only its unique team-scoped fixtures; it does not rewrite migrations, recreate schemas or disable production guards.

## Required queued verification

Run each mock-heavy suite in a fresh Bun process, with no real provider credentials or external IO:

- apps/api/src/services/inbox-webhook-ingestion.test.ts
- apps/api/src/__tests__/inbox-webhook.test.ts
- apps/api/src/__tests__/inbox-erasure-contract.test.ts
- apps/worker/src/processors/inbox/process-attachment-deletion.test.ts
- apps/worker/src/utils/resource-cleanup-deletion.test.ts
- packages/supabase/src/client/deletion-proof.test.ts

After applying the reviewed upgrade to the isolated fixture:

- packages/db/src/test/inbox-deletion-receipts-postgres.test.ts
- packages/db/src/test/resource-cleanups-postgres.test.ts
- Existing resource-deletion, Storage ingestion/bucket access and entitlement suites as selected by the integration owner.

The targeted PG tests cover physical removal and proof privacy, scoped ACLs, immutable identity/hash, exact legacy size and lease/token fencing, post-delete OCR/projection, shared-object batch deletion, Storage-first and deletion-first interleavings, team-cascade lock order in both directions, and refusal of old repeatable-read snapshots. Concurrency barriers observe pg_blocking_pids rather than guessing that a race occurred. The expired-lease test waits only until the recorded SQL deadline while holding an unchanged tuple lock.
