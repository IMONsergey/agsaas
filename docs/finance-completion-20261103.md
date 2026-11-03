# Financial reliability implementation, 2026-11-03

Base: `8269ed3d2c25a0b6b92510b173594b08dfd5b473`.
Worktree: `/opt/agsaas/work/finance-20261103`, branch `work/finance-2026-11-03`.

## CODE-10 / CODE-11: invoice commands

Implemented shared `issueInvoice`, `scheduleInvoice` and `cancelInvoiceSchedule` commands. Row locks serialize invoice changes. Manual issue captures the immutable document, status and financial queue intent in the same SQL transaction. Each issuance delivery type has a stable operation identity. All three interfaces (tRPC, REST, MCP) use the domain command and return the durable operation status where their response carries the issued invoice.

Schedules persist a generation marker and delayed generation intent before Redis is consulted. Reschedule/cancel no longer deletes a queue job before SQL commit. The reconciler derives delay from the persisted timestamp; obsolete generations remain harmless because generation/email processors check the current schedule marker. The old schedule processor remains compatible with already queued jobs.

PDF generation persists an email handoff intent instead of depending on an ephemeral Redis-only send job. Email delivery retains the existing provider receipt/idempotency implementation. Queue acceptance is not represented as delivered email.

Migration: `packages/db/self-hosted/upgrades/supabase/migrations/20261103060000_invoice_commands.sql` extends only the allowed financial outbox job pair. It does not schedule or send historical invoices.

Tests added/updated: SQL rollback, conflicting intent rollback, concurrent duplicate issue, tenant negatives, concurrent schedules, failed reschedule rollback, cancellation and immediate-send invalidation, finalized-state negatives, delay reconstruction, malformed timestamp negative, generation email-intent failure/retry, API negative assertions for no split Redis/status write.

Verification: source review and `git diff --check`; parent-authorized job `20261103T055150-a62a79c5b9` passed 59 invoice delivery and 48 API invoice tests. Typecheck stopped on one optional test assertion; corrected. SQL acceptance and full typecheck completion remain pending the isolated regression database and root queue. No live invoice, payment, email, migration or deployment was performed.

Limitations: a fresh POST without a client operation identity remains a new creation request; issuance retries of the same invoice reuse the durable operation. Automatic historical reconciliation does not invent intentions for invoices issued before this change. Provider acknowledgement races remain governed by the existing delivery ledger.

## Subsequent packets

Export snapshot/manifest/immutable storage and activity aggregation are in progress and are not included in the invoice packet acceptance.


## CODE-17 / CODE-20 / CODE-21 / CODE-22: export integrity

A persistent SQL `export_snapshots` contract now captures a repeatable-read data selection before file IO. Retries use the same request/snapshot identity and reject changed request bytes. The complete business export reads full financial rows rather than UI projections, including immutable invoice documents and all printable blocks, templates/products, recurring records, payment reservations and delivery receipts, account/category/tag relationships and tracker records without arbitrary date bounds. Credentials, link bearer tokens, delivery envelopes/leases, search indexes and previous generated exports are intentionally excluded and declared in the manifest. Encrypted bank account fields remain encrypted as stored; the export is not a provider history dump or a disaster recovery backup.

Archives use `team/exports/operation-hash/archive-sha256.zip`, `upsert:false`. Identical retries verify existing bytes before reuse; distinct operations never replace one another. Files have fixed archive timestamps and unique per-record names. `manifest.json` lists entity counts, source paths, exact byte hashes, missing/invalid required files and missing transaction rows. JSON retains original values; CSV neutralizes formula prefixes while preserving numeric negative amounts. Partial/failed outcomes are visible in the dashboard and are not shown as success. Only rows with all required attachments and unchanged current business data are marked exported.

An independent offline verifier is provided at `scripts/verify-export-archive.py`. SQL rows have one snapshot boundary; Storage bytes are read later and hashed. No unsupported historical object-version guarantee is made.

Migration: `20261103061000_export_snapshots.sql`, backend-only RLS with immutable snapshot and completed-receipt guards. No production application performed.

Verification: job `20261103T060455-6c5e22bdcf` passed 6 tests / 49 assertions, including parallel exports, replay and corruption negatives, partial/missing file states, zero-IO foreign paths, CSV control/formula cases and independent archive verification accepting intact/rejecting altered ZIP data. Typecheck stopped at a required fixture customer email (fixed). Full worker/API typecheck and isolated SQL acceptance remain pending.

## CODE-26: client activity aggregation

Invoice count and tracker duration are independently aggregated per customer before joining. Existing 30-day, status and integer-hours scoring semantics are retained; tenant scopes are explicit. Added a PostgreSQL regression where three invoices plus one hour must not beat one invoice plus four hours, and an inactive/foreign-tenant negative. SQL execution pending.


## CODE-23 / CODE-24 / CODE-25: public financial reports

New report links persist computed chart values and filters in a repeatable-read SQL transaction. Gross/net and forecast horizon are serialized. Snapshot calculations bypass the process category/currency caches. Snapshot rows and financial filters have a SQL immutability guard. Previously created links retain explicitly labeled live behavior rather than receiving fabricated historical data.

Public metadata and chart reads both check expiry and irreversible revocation on the primary database. The public DTO omits tenant/creator/internal report IDs. Public report pages/images request dynamic rendering. Owners can create/revoke public links; team members can inspect a paginated management list. The existing metric share dialog now exposes previous links and their snapshot/live/expired/revoked state. Revenue/profit/forecast cards pass their actual gross/net selection.

Migration: `20261103062000_shared_report_snapshots.sql`. Tests cover immutable values after edits, gross/net equality to the dashboard calculation, metadata expiry, foreign revoke negatives, immutable revocation, legacy live behavior and preserving legacy links during upgrade. API tests include non-owner negative assertions (no business write), filter serialization and tenant-scoped management.

Security integration dependencies were applied in this isolated branch: original `9b394375d5991dcffb356c56f82b0a2fe8693de3` (local cherry-pick `46b0d4f`) and original `6a6a09c75e2578a639f815779df42ef6fa06a8e6` (local cherry-pick `c0ad1c6`). Export rewrites preserve the team-bound Storage client and validate every required source path through the shared tenant guard before IO. Root should apply each security change only once when integrating finance commits.

Final combined source/type and isolated PostgreSQL jobs are prepared, not yet accepted. No live data or production migration was changed by this branch.


## Acceptance correction packet, 06:23 UTC

The first complete PostgreSQL run (20261103T061605-bb492c1250) passed all eight invoice command scenarios (36 assertions), including concurrent issuance, competing schedule generations, rollback after business changes, tenant refusal and terminal state protection. It exposed a real export query error: direct Drizzle array interpolation was rendered as a tuple rather than a PostgreSQL array. Typed ARRAY construction now binds every element independently; selection IDs also enter the operation request hash. Fixtures missing customer email/category foreign keys and UUID-to-text casts were repaired without weakening negative assertions. The generic public invoice update endpoint was additionally found to bypass dedicated commands. tRPC, REST and MCP now share updateInvoiceWithIntent; unpaid and scheduled changes use the same SQL intent boundary, cancel invalidates generation markers, and manual paid status keeps settlement while atomically requesting PDF generation only. New SQL and protocol tests cover this path.

The aggregate run 20261103T061603-25f252d97e failed, with all four typechecks attempted. Corrections include public report DTO expectations, the CommonJS-compatible guarded test migration helper, duplicate public route revalidate declarations and undefined archive receipt handling. A completed queue job without a complete receipt now produces an error notification and no success sound. The required workbench build is added before dependent typechecks. Security follow-up 6a615f99 was cherry-picked as 8b49abb (tracked owner mocks and Storage type narrowing); root must not apply duplicate security patches.

This correction packet is not marked accepted until the next PostgreSQL and aggregate jobs complete. No production migration or live email/payment action has been performed. Browser verification of updated report management and export notification remains with the integration owner.

PG rerun 20261103T062926-358c865df1: invoice commands 12/12 PASS, invoice upgrade 1/1 PASS, export snapshots 5/6, client activity 2/2 PASS, shared reports 2/4, shared report upgrade 1/1 PASS. The remaining three failures were Bun requiring a real Promise for rejects assertions, while Drizzle supplied lazy thenables. The corrections explicitly execute the SQL and assert exact PostgreSQL P0001 trigger messages plus unchanged data; the negative checks remain mandatory. A fresh run is still required.


## CODE-07 integration fence

getInvoiceCommandPreview returns primary locked invoice/customer revision plus exact recipient, bcc, customerName, replyTo, amount, currency, invoiceNumber and status. issueInvoice optional expectedRevision is checked under the invoice row lock before mutation and freezes all approved delivery recipients into generate/send SQL payloads. deleteInvoiceWithRevision rejects stale data before the existing protected deletion. All accept DatabaseOrTransaction, so an outer assistant-approval consume transaction rolls back with the nested invoice command. An accepted approval replay must return its saved receipt rather than call the stale preview again. Worker tests forbid any network and assert mutable customer/BCC/user/reply-to data cannot redirect the approved send. SQL tests cover stale invoice/customer, recipient substitution, outer rollback, foreign tenant and current deletion. These new tests are not yet executed; the source lives in a separate ledger worktree while the earlier finance gate is frozen.


## Ledger, Polar and UI metrics source packet

See docs/finance-ledger-contract-20261103.md for engineering contract, independent scenario ledger and pending merged acceptance. No live data, provider calls or production migrations were made. New source has not yet passed its combined test gate.


## CODE12 allocation source packet

Added atomic SQL workspace quotas, protected entitlement columns, immutable monthly Inbox/invoice use, durable Composio reservations, exact immutable-source generated-file grants, primary usage UI, safe API errors and isolated concurrency/rollback/direct-SQL regressions. See docs/code12-entitlements-20261103.md. Source is not accepted until the merged gate passes; no production migration or provider call performed. RDC reached its monthly limit before final source review/commit, so the finalizer was prepared locally for a separately authorized source channel. Parent controls every heavy job.
