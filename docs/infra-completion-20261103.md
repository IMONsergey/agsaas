# Infrastructure completion 2026-11-03

Base: 8269ed3d2c25a0b6b92510b173594b08dfd5b473. Branch: work/infra-2026-11-03.

## Boundaries
- Server work through Remote Desktop Commander. No secret values in logs/artifacts.
- No production migration, timer, restart or ingress changes without root integration coordination.
- Heavy installs/tests/builds are delegated to root's imon-job queue.
- Existing installed baseline remains immutable; new migrations are incremental and ordered.

## Work in progress
- CODE-02: authoritative Auth-factor / top-level JWT assurance policy added as an incremental SQL migration. Restrictive policies cover all nine browser-readable/writeable relations including profile and bank reconnect. Real PostgreSQL rollback tests cover AAL1/AAL2, no/unverified/removed factors, stale sessions, metadata spoofing, cross-tenant boundaries, replay and missing authority.
- CODE-09: transactional Storage metadata projection, canonical tenant ownership, unique object/path identity, replay-safe analysis preservation, content revision reset, delete/archive handling and bounded native reconcile added. Missing objects after a lost delete are flagged without erasing recoverable metadata. Nine real PostgreSQL trigger tests are ready for isolated validation. This packet does not claim AI extraction/provider readiness.
- INF-01/02: app-consistent snapshot/restore + offsite/retention tooling pending.
- Exact test commands/results and commit receipts will be recorded after root's isolated validation. No validation is claimed yet.

## Ordered fresh installation
Preview bootstrap now runs the immutable baseline and every sorted incremental migration in one transaction, with full rollback rehearsal before commit. Shared history validation rejects altered/unknown/duplicate/out-of-order migrations. The historic stage one-time bootstrap remains a legacy helper; it is not a release path. Real PostgreSQL success/rollback and final-upgrade failure tests are prepared; root queue validation remains pending.

## Validation receipts
- Setup59applicationtablespassed in job20261103T060600-cab02aebfb after replacing unavailable bunx with pinned bun x. Initial fixture cleanup/required bank institution fixes committed.
- Job20261103T060850-b0d09c4e37: MFA6/6passed; Storage8/9passed, backend namespace USAGE missing (fixed explicitly in ingestion migration, retestpending); migration chain2/2realPGpassed; chain/preview21/21passed.
- Backup safety6/6passed and all3Pythonfiles syntaxpassed in job20261103T061553-d615d11cda. Real privileged recoverytest remains root-coordinated.
- New backup dryplan at06:14:31UTC succeeded against actual preview8269ed3:3,953,687,856estimatedbytes including allimages/source; offsite9,546,797,056available vs13,136,675,627required, failsclosed with8GiBreserve. No livecontainer stop/upload/timer applied. Sanitizedreceipt: /home/sergey/Work/Reports/agsaas-completion-20261103/backup-dry-plan.json.

## Own public/runtime packages
- 4b6dbc43b854ed4674906006cfda96d769966df1: privileged adapter respects actual existing heavy.lock (0600 uid1000 inode7190787); no queue/ACL/NNP change. Added owned control/TLS directory to recovery contract.
- 401260c885d1b9296f54d4ffd482e1e8bd388797: own website native Node Docker, compose.public loopback3501, Nginx94.249.186.240:8546, noindex, exact OCI/runtime provenance. Requires root website source merge before build.
- bd29b678c26c990aab452a6dfb57cea5a68d0d81: trusted live TLS/renewal proof and real Auth→RLS→Vault→metadata→cleanup canary. No live reload/renewal/canary mutations applied.
- Native banking/onboarding: source inventory complete; security ownership contract requires connectionId+teamId and authoritative versioned DB credentials. New consents remain fail-closed until verified lifecycle is implemented.

## Remaining infrastructure ledger
- INF-01/02: first real privileged synthetic recovery pending root; independent full image+data payload fails current offsite capacity gate.
- INF-03/04/16: own IP8546 chosen, source packaging ready; integrated image/live ingress and upstream retirement pending acceptance. DNSimon.world currently95.163.244.138, ownappsubdomains unresolved.
- INF-05/06/19: real mail/banking/payment/provider credentials and release scope remain explicit configuration gates; no false delivery/payment readiness.
- INF-07/CODE-13: native bank/onboarding runner next.
- INF-08: operational monitoring and real alert route still to wire.
- INF-09/10: real renewal and full business canary receipts pending approved integrated runtime/account.
- INF-11: inherited OCI labels fixed in source; exact integrated build/runtime proof pending.
- INF-12/14: fresh isolated merged candidate must use separate keys/data/network/ports and whole chained migrations; old stages remain untouched. Cold recovery is the rollback contract for non-reversible schema changes.
- INF-13: capacity fail-closed, no foreign snapshot deletion.
- INF-15: isolated PG tests mostlypassed, one ingestionnamespacefixture fix needs rerun, full merged gate pending.
- INF-17: websiteheaders supplied; dashboardCSP/HSTS acceptance still open (IP literals do not persist HSTS).
- INF-18: bounded root/queue resources supplied; measured candidate baseline/load evidence still required.
- INF-20: durablekeys/rootTLS included in backup; explicit lifecycle/rotation and recovery evidence still to finish.

### Recovery integration fixture correction
The privileged adapter acquired the original shared lock and failed closed on an unowned anonymous image volume before snapshot (receipt backup-synthetic-9baf85e7.json). The synthetic storage placeholder now explicitly binds the Redis image’s declared /data volume. No production service was read or stopped; own fixture containers and named volumes were removed. Real recovery assertions remain pending the corrected retry.

### Independent Auth cookie namespace
NEXT_PUBLIC_AUTH_COOKIE_NAME now flows through all existing browser/server/middleware wrappers via their shared cookie-options helper, and through matching build/runtime Compose configuration. The default remains the existing SDK name until an intentional session migration. Candidate requires agsaas-candidate-20261103-auth, avoiding same-IP/different-port session replacement. Secure/path/HttpOnly/SameSite behavior is unchanged. SDK-level shared-cookie-jar regression tests cover independent sessions and local logout; queued validation pending.

### Real cold recovery acceptance
Corrected privileged integration cd0ca692 passed all 14 assertions through the original heavy.lock in 197.18s. Receipt /home/sergey/Work/Reports/agsaas-completion-20261103/backup-synthetic-cd0ca69.json: physical PostgreSQL16 restored row, Storage bytes, durable key, Redis AOF, network-none/noports, service finally recovery, checksum tamper and overwrite refusal. Synthetic fixtures only; no production snapshot/offsite acceptance inferred.

### Exact-release candidate and complete browser upload boundary
Added guarded fixed candidate profile under /opt/agsaas/candidate-20261103 with fresh Auth/DB/Storage/Redis/key state,17 bounded services on an internal network, no automatic restart, loopback13500/13501/13503/14000 and explicitly selected host ingress8547-8550 (existing valid certificate stays on host; no443/VPN change). Shared-lock adapter supports only fixed candidate actions. Preparation requires clean exact source, independent namespaces, actual pinned installed platform images, no external provider credentials and distinct Auth cookies. Full chain rollback rehearsal precedes atomic installation; four candidate images build sequentially; explicit GoTrue admin synthetic accounts remain private. Ingress checks health/noindex/trusted TLS/image headers and rolls back only its newly added file on failure. Nothing is deployed by this commit.

Runtime metadata confirmed vault is the only bucket and Storage has no browser policies; direct browser uploads in CSV/attachments/avatar/logo controls therefore lacked a usable path. Migration20261103093100 adds private Vault membership and intended-public raster image namespaces with active-session/MFA/self/owner gates and restrictive protection against permissive-policy bypass. Public image references are immutable random paths with5MiB/MIME limits; financial/private uploads remain in private50MiB Vault. Existing incompatible bucket settings fail without visibility changes. Every image upload control now explains public-link visibility. Nginx public asset responses add nosniff and sandbox CSP. Source guards, actual-SSR cookie isolation,7 PostgreSQL role/tenant/session cases and existing MFA/ingestion fixtures all await the integrated aggregate gate; fixtures apply actual071000 with genuine Auth sessions, never a constant assurance bypass.

Dependencies: root071000 active-session migration; complete root/security/finance source before candidate build. Candidate instructions and explicit open operational gates in deploy/self-hosted/CANDIDATE.md. Native bank/onboarding runner, real provider credentials/acceptance, independent full offsite restore, production maintenance backup, timers/alert route, measured load and reversible key rotation remain open. No corresponding feature is advertised as complete.
