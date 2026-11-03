# Reserved export file access

## Finding and authority

Full-team and transaction ZIPs share the private Vault namespace
`<team UUID>/exports/`. Both current producers store immutable archives at
`<team>/exports/<operation SHA-256>/<archive SHA-256>.zip`.
Historical full-team and transaction producers also used this namespace, with
date-based flat filenames.

A scoped credential with documents.read could previously list an indexed
full-team archive and obtain its bytes or an administrative signed URL. Adding
other API/OAuth scopes did not make that credential eligible to initiate a
full-team export: team.exportAllData uses the interactive protected procedure.
The archive therefore exposed data outside the credential's read scopes.

The new guard preserves that existing authority:

| Principal / file | Required authority |
| --- | --- |
| Ordinary Vault file | Existing endpoint scope and current team membership |
| Current transaction archive | Existing endpoint scope, transactions.read, exact primary receipt, safe immutable attachment snapshot |
| Full-team archive | Verified interactive member session or its verified file capability |
| Unknown, malformed or legacy reserved archive | Verified interactive member session or its verified file capability |

Interactive membership is not an owner-only operation. Existing primary
membership, session revocation, MFA and file-admission checks remain responsible
for validating that session. The new guard receives a server-derived principal;
request headers and MCP tool arguments cannot grant interactive authority.
MCP receives sessionId only for the verified session authentication branch.

## Primary receipt boundary

getExportFileAccessReceipts accepts at most 100 distinct lower-case operation
hashes and an authenticated context team. It routes to the primary database.
Only scalar identity fields, whitelisted receipt keys and one computed
transaction_assets_safe boolean leave PostgreSQL. It does not select or return
snapshot, transactionRows, provider configuration, credentials or arbitrary
result keys.

The shared validateExportArchiveReceipt implementation binds the row's team,
snapshot ID, operation, snapshot hash, kind, version, canonical snapshot time,
receipt status, counts, archive hash and exact path. The access layer also
requires the verified kind to be transactions and the requested path to match.
Database failures return an unavailable error; they never fall through to an
administrative signer. Receipt validity is separate from current Storage object
existence.

Partial and failed diagnostic archives are not described as complete.
Unknown or invalid receipts do not create a download right.

## Issuing surfaces

| Surface | Boundary |
| --- | --- |
| REST documents list and get | Filter or deny reserved archive metadata according to the verified principal |
| REST document presign | Guard before administrative Storage client/signing |
| REST Inbox and transaction attachment presign | Same guard on the persisted attachment path |
| files/download/file and files/proxy | Existing real credential / file-capability authentication, then the same path guard before the handler |
| MCP documents list/get and Inbox get/download | Same receipt guard before administrative signing or binary download |
| MCP transactions_export result | transactions.read before enqueue; guard on the returned archive path |
| MCP export_job_status | Team and explicit job-name allowlist before reading progress or result, then path guard |
| Protected tRPC document signing and member-created shares | Existing interactive member authority retained |
| Native Storage authenticated Vault access | Existing active Auth session, MFA and team policies; opaque API/OAuth tokens are not Storage JWTs |

All getVaultSignedUrl and downloadVaultFile callers now pass server-bound
McpContext. Document signing uses the exact persisted pathTokens path once;
it does not prepend a duplicate team segment or append a duplicate name.

The short_links table is backend-only. The reviewed public recipient flow
looks up an exact unguessable short ID and honors expiry. A member who already
has full export authority may intentionally share it. The scoped API and MCP
have no short-link enumeration or document-share creation surface; their
learned archive IDs/paths do not bypass the new signer boundary.

## Nested archive and attachment consumers

A transaction attachment may contain a caller-provided same-team path.
Previously an attachment targeting a full-team ZIP could be wrapped in a new
transaction archive. collectExportAssets now records reserved /exports
attachments as invalid before Storage IO. Old transaction receipts are also
checked against their immutable transactionRows in PostgreSQL. Missing or
malformed attachment/path shapes are closed, as are foreign, encoded and
reserved export references. No snapshots or historical receipts are rewritten.

Repeated full-team exports continue to work: snapshot capture already omits
auto-indexed /exports document rows and their tag assignments. Generated
archives are derived artifacts, so they are not recursively embedded.
An archive explicitly attached to a transaction, Inbox item or invoice remains
an unavailable requested asset, produces a partial result, and is not silently
counted as included.

The direct attachment consumers were checked separately:

- The full and transaction archive processors, including legacy process-export,
  use collectExportAssets.
- Accounting sync validates the exact team path and refuses reserved exports
  before Storage download. It records failedCount and a partial sync mapping;
  spoofed filename/MIME metadata cannot authorize an upload.
- Transaction attachment OCR rejects reserved exports before Storage signing,
  HEIC conversion, document processing or downstream classification. This is a
  permanent validation failure.
- REST attachment URL issuance uses the shared API guard.

The transaction export email branch signs only the newly built complete
transaction archive. A complete persisted replay returns before that email
branch; an omitted reserved attachment cannot produce a complete new archive.

## Prepared verification

This packet has source review and formatting evidence. Runtime acceptance is
pending the controlled queue; no provider, Storage, Redis or PostgreSQL call was
made while preparing it.

Run each unit file in its own Bun process to isolate module mocks. Use the
existing sterile unit environment, without TEST_DATABASE_URL, provider keys,
Storage credentials or live Redis. The API boundary test imports its existing
setup mocks explicitly. The real authentication suite uses its own signed JWT
and file-capability fixtures and must retain its existing queue harness.

| File | Cases | What is exercised |
| --- | ---: | --- |
| apps/api/src/__tests__/auth/file-access.test.ts | 25 total, 8 added | Real API-key/OAuth/JWT/file-capability middleware, primary membership, MFA, forged labels and direct archive paths |
| apps/api/src/__tests__/export-file-access.test.ts | 18 | 11 real REST requests and 7 actual in-memory MCP transport cases, Storage no-IO denials, scoped transaction archives and member access |
| apps/worker/src/utils/export-archive.test.ts | 9 total, 2 added | Current and legacy nested archives refused before byte reads, explicit partial outcome |
| apps/worker/src/processors/transactions/attachment-export-access.test.ts | 9 | Production accounting/OCR processor bodies, no reserved download/upload/sign/OCR, ordinary positive paths |
| packages/job-client/src/export-job-access.test.ts | 4 | Real status reader denies job kind before reading state/progress/result; team check retained |
| packages/db/src/test/export-file-access-postgres.test.ts | 1 | 14 native SQL snapshot variants, whitelist projection, team binding and exact transactional rollback |

The shared receipt validator's 32 cases were delivered separately in ca23ec11.
Existing protected document and short-link tests remain useful compatibility
checks; their authorization was not replaced.

The new PostgreSQL test needs the existing synthetic export_snapshots schema,
not a new migration. It creates one random team and 14 rows inside one
transaction, then rolls back using an exact sentinel. Assertion failures also
roll back. It does not call cleanDatabase, disable triggers, apply DDL or commit
fixtures. The ordinary pool is closed at suite end.
