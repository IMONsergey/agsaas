# Isolated restore rehearsal, 2026-11-01

This is a **single-owner, same-host drill**, not an unattended production
deployment command. The helper deliberately pins one namespace and refuses
arbitrary target arguments. Run only with the owner's explicit administrative
authorization. Never substitute the active stage paths for the rehearsal.

| Boundary | Active stage | Rehearsal |
| --- | --- | --- |
| Compose project | `agsaas-stage` | `agsaas-rehearsal-20261101` |
| Source | `/opt/agsaas/source` | `/opt/agsaas/rehearsal-20261101/source` |
| Runtime | `/opt/agsaas/runtime/supabase` | `/opt/agsaas/rehearsal-20261101/runtime/supabase` |
| Dashboard / API | loopback 3300 / 3303 | loopback 3400 / 3403 |
| Supabase / captured mail | loopback 3800 / 3825 | loopback 3900 / 3925 |
| App images | existing release tags | `rehearsal-<full commit>` tags |

The final Compose layer is `compose.rehearsal.yml`. The network is internal:
application runtime cannot call Stripe, Resend, banks or AI services. Builds
are separate operations and need dependency downloads. There is no public
ingress, host network, Docker socket mount or change to the existing VPN.

## Before any mutation

1. Check the existing stage and VPN health and source commit. Confirm capacity
   for a second bounded stack and serial image builds. Do not prune unrelated
   Docker resources to obtain space.
2. Use the exact matched Supabase snapshot, `self-hosted/v0.8.3`, commit
   `bc27d2661edd09a5d0b8d76ce33da6d4071a756e`, PostgreSQL
   `supabase/postgres:17.6.1.136`. Do not mix a major upgrade into this drill.
3. Create the dedicated root and clean source clone. The helper requires
   canonical paths, owner-only private inputs, exact project/container/mount
   identity and project-owned local volumes without driver aliases.
4. Read `scripts/self-hosted-rehearsal.mts` and its current tests before use.
   It does not start/stop services, build images, clean volumes or replace the
   active checkout. Those are separate explicitly inspected operations.

Use the server's pinned Node executable, not the older system Node:

```sh
sudo -n /opt/imon-runtime/node/bin/node /opt/agsaas/rehearsal-20261101/source/scripts/self-hosted-rehearsal.mts --help
```

## Normal sequence

- `prepare`: create new runtime from the matched public snapshot; keep the
  owner's cryptographic material on the same host so restored records remain
  readable. Retarget all URLs, tenants, image tags, volumes and ports. Mailpit
  is capture-only and automatic Auth confirmation remains disabled.
- `config`: inspect the **merged** Compose model. Only the four intended
  loopback endpoints, owned mounts and internal network are accepted. Do not
  print the rendered model: it includes private environment values.
- `snapshot`: capture PostgreSQL custom dump, private environment, db-config
  archive and canonical permissions. Inventory and permissions are checked
  before/after the dump. Nonempty Storage stops this bounded drill; it needs
  a separate coordinated object-byte snapshot.
- `seed-config`: seed only the fresh rehearsal db-config volume from a
  validated archive before the new database first starts. Preserve the
  pgsodium root key, UID/GID and mode, and compare its hash afterward.
- Start **only the rehearsal DB**, with the complete reviewed Compose file
  list, project name and `--pull never --wait`. No other rehearsal writers
  may be running during restore or upgrade.
- `restore`: verify dump/image/key identity, restore the observed non-login
  Realtime ownership role, and provision `agsaas_app` as the built-in
  administrator. Normalize target default ACLs before the dump creates
  objects. Restore with `--single-transaction --exit-on-error`; never use
  `--no-owner` or `--no-acl` to suppress a mismatch.
- Compare canonical object/column/schema/function/type permissions, RLS
  policies, role attributes, memberships and defaults. Null ACLs represent
  PostgreSQL's hard-wired defaults, not the current `pg_default_acl` entries.
  Post-restore proof must pass before `upgrade` is allowed.
- `upgrade`: apply only the exact missing suffix of reviewed migrations in
  timestamp order, in one bounded transaction with an advisory lock. Keep
  immutable baseline hash and previously recorded SQL unchanged. Only DB may
  be running; never use disposable test setup or Drizzle push here.
- Build API, worker and dashboard serially from the exact clean source commit,
  using only the separate rehearsal tags. Start the isolated stack only after
  database verification and successful builds. Preserve private build logs.
- Run real HTTP/Auth/Mailpit smoke from the host using the runtime environment.
  Do not expose OTPs, bearer tokens, email bodies, backup content or secrets in
  command output. Check original stage/VPN health again after the drill.

If the clean source commit changes **before application startup**, `retarget`
changes only the rehearsal release. It first compares every private setting
with the captured configuration and requires unchanged deployment layers. It
preserves the previous environment and refuses operator changes or running
writers. It does not rebuild or restart anything automatically.

## Recovery discovered during this specific drill

The original data snapshot had no permission metadata. A separately labelled
supplemental ACL snapshot was captured only after checking source identity,
baseline, inventory and commit. Do not describe it as part of the earlier
data-snapshot instant.

The first legacy restore inherited Supabase browser default grants and one
PostgreSQL 17 creator-role membership. `repair-restore` is a one-time guarded
repair of **that unchanged baseline copy only**. It retains the prior database
dump, permission metadata and proof before modifying the copy. It is not a
generic reset command.

Strict `pg_restore --clean` then encountered an inherited Realtime partition
primary key. The failed transaction rolled back. A separate
`resume-partition-restore` action requires the preserved attempt, exact known
failure and unchanged inventory. The root primary key is removed with
`RESTRICT`, after a rollback-only probe and an empty-table guard; no `CASCADE`
or table deletion is used. PostgreSQL removes its internally owned child PKs.
The original custom archive is then restored without suppressing errors or
editing the TOC. Failure proofs are retained, not erased to enable blind retry.

Two extension-owned Net function settings and two GraphQL schema grants were
not reproduced by the archive alone. `matchedExtensionRestoreSql` permits
only the exact observed before/after metadata for these four records and
simulates equality of the entire permission snapshot before returning static
SQL. The change is probed in a rollback-only transaction and checked again
after commit. No unrelated permissions are normalized. The one-time
`finalize-extension-restore` action completes the already restored legacy
copy; it does **not** run another database restore.

Private failure logs and snapshots remain owner-only on the host. A missing
or failed proof is a stop condition for application startup. Investigate it;
do not weaken an authorization check or claim a partially restored copy is
safe because table counts happen to match.

## What this does not prove

- No off-host backup, PITR, whole-cluster `_supabase` backup, Redis/AOF restore
  or nonempty Storage restore. The snapshot contains three profiles/teams and
  no invoices, transactions or Storage objects.
- No large-production-dataset migration performance guarantee.
- No external provider delivery, real bank or payment transaction, public
  HTTPS readiness, full browser regression or complete security audit.
- Cloning existing crypto material is confined to the owner's private drill.
  This is not a recipe for reusing secrets across independent deployments.

The source stage remains available throughout. Cleanup and production cutover
are separate operations; the helper has no `down`, `reset` or prune command.
