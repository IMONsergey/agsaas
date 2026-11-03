# AGSaaS implementation and self-hosting checkpoint

Date: 2026-11-03

This checkpoint records completed source work and the specific verification available for it. It is a continuation record for maintainers preparing an independently operated deployment. The application has not been accepted as a production deployment, and the planned 17-service candidate runtime has not been installed.

## Code continuity and publication

The code checkpoint immediately before this documentation commit is identified by:

| Identity | Value |
| --- | --- |
| Rejoined code commit | `07bf353838a1e5aaef6b90295203847f3ee0ffb1` |
| Reviewed snapshot commit | `0b0164184279367afcfca6e7e2b2511b40c61b0c` |
| Expected code tree | `a27fcaea6d87d0344be5f7a11cde986e8bbafb7b` |
| Snapshot descendants replayed onto full upstream history | 109 |

The history rejoin preserves upstream ancestry and reproduces the reviewed code tree. The new draft pull request targets `refactor/stability-baseline-2026-10-31`, the existing branch used by PR #1. Keep the rejoin evidence and the subsequent documentation commit distinct: adding this document changes the repository tree without changing the verified implementation. Publication does not merge the change or deploy services.

## What changed

**Exports and recovery.** A transient failure to read export status now preserves the job handle and offers another status read. It does not report a terminal failure or allow a duplicate export command. Read-only export history provides recovery after a reload from durable archive receipts. Its primary-database queries enforce current team authority and return a limited metadata DTO. Downloads initiated from export history require a fresh receipt check and exact team, operation, snapshot and archive-path bindings. Partial and failed results remain visibly incomplete or diagnostic. Missing receipts do not imply that a job finished or failed.

**Archive access.** Full-team archives are distinguished from ordinary document attachments. Shared receipt validation and access checks prevent document-only permissions from granting broader export access. The checks cover relevant file-serving, signing and integration boundaries, including accounting attachments and export enqueue permissions. History does not expose raw snapshots, transaction rows or provider credentials.

**Financial operations.** Settlement changes recheck current authority and invoice state. Provider uncertainty survives projection and event replay and blocks additional money operations until supported reconciliation resolves it. Refund requests retain a durable intent before provider dispatch, immutable bindings, bounded same-key retry and write-once provider identity. Recovery uses exact known resources and does not treat an unknown outcome as a failed payment or manufacture proof of absence. Financial queue producers now participate in resource admission while retaining their existing job options.

**OAuth and bank consent.** Hosted consent commands bind the current owner, team and session. Database checks enforce authority, expiry and operation fencing, while the UI separates recovery state between authenticated sessions. Uncertain exchange outcomes remain explicit. Late or canceled grants retain the information required for durable cleanup. External provider completion is not inferred from browser-supplied identifiers.

**Erasure and background cleanup.** Inbox deletion remains a physical deletion. A separate restricted receipt retains only the identity and digest evidence needed to reject resurrection and recognize an exact redelivery. It does not preserve message text or extracted business data. Storage and document guards coordinate with deletion, and background output cannot recreate a deleted receipt. Cleanup retains bounded digest observations under the active lease; uncertain reads do not indefinitely prevent byte erasure. Command responses expose pending cleanup honestly.

**UI, PDF and queues.** Inbox query failures reach the existing error/retry path while real empty states remain intact. Export recovery includes explicit read and download failures. PDF and image handling received rendering and validation fixes. Queue reservations use generation checks, and worker releases also verify the current lock. Retry admission is atomic for the supported retry operation, so stale workers cannot release a newer reservation.

## Verification ledger

These are separate runs with different scopes. Their counts must not be combined into a claim that every test passed on every historical commit.

| Gate | Recorded result and scope |
| --- | --- |
| R9 PDF | 17 PDF/font checks passed. This is the PDF result, not a claim that every R9 step passed. |
| PG9 | All nine PostgreSQL suites passed: 142 cases, zero failures or skips. |
| R10 | 104 cases passed and 24 failed; four steps failed. The run exposed remaining test-fixture setup and typing problems and was not accepted as green. |
| R11 follow-up | 26 cases passed, zero failed; database and API typechecks passed. This targeted follow-up resolves its recorded failures without pretending to rerun every earlier gate. |
| Export PostgreSQL gate | History: five cases passed. Archive access: one atomic rollback case passed, containing 14 fixtures; those fixtures are not 14 separate tests. |
| Isolated Redis gate | All 12 cases passed. |
| Post-erasure PG4 rerun | 35 cases passed: 13 erasure, six cleanup, nine Storage ingestion and seven bucket-access cases; zero failures, skips or TODOs. Catalog fingerprints and source files remained unchanged, and all child process groups finished without supervisor signals. |

The SQL gates used a synthetic PostgreSQL 16.15 fixture; they do not establish acceptance of the complete PostgreSQL 17, Auth, Storage or Realtime deployment. Redis was a private Redis 7.0.15 process. The R10 dashboard production build passed with synthetic, nondeployable public origins, and the six package/application type checks passed across R10 and R11. No new build for the rejoined Git identity is claimed.

The preceding PG4 run passed 13 erasure and six cleanup cases. Storage ingestion passed eight cases and failed one; the bucket suite was not run. The failure expected the earlier namespace-guard message after a newer BEFORE trigger became active. The correction changes only the test: it selects the exact installed guard contract before the attempted write and verifies that no object, document or projection was inserted. Migration bytes and production guards remain unchanged. The complete rerun passed on the reviewed snapshot listed above.

The current 90-item source progress registry and 17 additional findings are preserved in [the continuation status file](docs/completion-20261103/continuation-status.json). Its source stages are distinct from production acceptance.

## Audit coverage and deployment handoff

The 99-page audit is a **source audit**. Historical browser evidence covers 26 desktop screens and seven mobile checks. It does not establish a complete browser pass over all 99 pages or acceptance of the current candidate. Remaining browser work must exercise the actual deployed build and its own authentication, Storage and tenant boundaries.

The self-hosting preparation includes isolated configuration, migration provenance, bounded launch scripts and recovery procedures. The full queue quarantine protocol and candidate runtime remain uninstalled. The current automation process lacks Docker socket access, and its permitted profile does not allow privileged administration. Docker group membership alone would not satisfy the launcher: it requires a root session and root-owned source.

An administrator should follow the [candidate runbook](deploy/self-hosted/CANDIDATE.md) and [heavy-slot installation and acceptance instructions](deploy/self-hosted/heavy-slot/README.md). Preserve the existing queue lock, let older jobs drain, install the reviewed bundle, accept the isolated builder and recovery behavior, and then use the fixed bounded launcher. Ingress follows service and release verification.

Real owner identity, production domains and TLS, transactional mail, and the selection and credentials of enabled providers remain unresolved inputs. The synthetic candidate disables external integrations and mail. Its startup cannot establish real delivery or provider operation. Continue from these explicit boundaries before making a production-readiness claim.
