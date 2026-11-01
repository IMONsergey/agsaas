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


## Host access while the runtime network stays internal

On the actual Docker host, the internal bridge did not create host listeners
for the configured Compose ports: container inspection showed null published
bindings. The host could still reach the container addresses. The Compose
configuration check alone therefore does not prove reachable loopback ports.

Use [rehearsal-ingress.mts](../../scripts/rehearsal-ingress.mts) for bounded
host access. It accepts no target, URL, project or environment overrides. It
inspects the fixed local Docker socket, requires the exact project/service
labels, one internal private bridge, running containers and distinct addresses
inside its subnet. It remembers the network/container IDs and addresses and
checks them again every five seconds. An inspection failure or identity
change closes all listeners and active connections.

Only these listeners are created: `127.0.0.1:3400` (dashboard),
`127.0.0.1:3403` (API), `127.0.0.1:3900` (gateway) and
`127.0.0.1:3925` (Mailpit). There is a 15-minute lifetime, a shared limit of
32 connections, a 30-second idle limit and a 32 MiB combined byte budget per
connection. Payloads and Docker environment values are never printed.
The helper makes no Docker changes and does not enable provider egress.

During this drill the reviewed operator file is kept separately from the
already built clean application checkout:

```sh
sudo -n /opt/imon-runtime/node/bin/node /opt/agsaas/rehearsal-20261101/control/continuation/rehearsal-ingress.mts
```

Keep that foreground process alive only for the required host smoke checks,
then send SIGTERM or allow its fixed deadline to expire. Do not turn off
`internal: true`, attach a second network, change the global firewall or
publish a public listener to make a smoke pass. An occupied port must fail
closed; do not kill an unrelated listener.

## Preparing the main Edge Functions dependency cache

The matched `supabase/edge-runtime:v1.77.4` main entrypoint imports
`jsr:@panva/jose@6`. An empty cache cannot resolve that import inside the
isolated runtime. Prepare its **public dependency graph** separately, before
claiming startup success:

1. Inspect the exact rehearsal `functions` container and its project/service
   labels, image ID, sole internal network and mounted
   `agsaas-rehearsal-20261101_deno-cache` volume. Check the volume ownership
   labels too. Refuse an absent or differently owned volume.
2. Read `docker/volumes/functions/main/index.ts` from the pinned upstream Git
   object `bc27d2661edd09a5d0b8d76ce33da6d4071a756e`, not an unverified
   working-tree copy. Compare SHA-256 with the runtime entrypoint. Place only
   that public file in the separate build input directory, read-only.
   Never mount the runtime directory, environment file, Docker socket or
   application data into the dependency builder.
3. Stop only the rehearsal `functions` container while writing its cache.
   Run the same pinned image as a disposable builder with no private
   environment. The following is the command verified for this one prepared
   directory and existing project-owned cache:

```sh
sudo -n docker run --rm \
  --name agsaas-rehearsal-20261101-edge-cache-build \
  --network bridge --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 384m --cpus 1 --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,noexec,size=64m \
  --mount type=bind,source=/opt/agsaas/rehearsal-20261101/edge-dependency-build/source,target=/home/deno/functions,readonly \
  --mount type=bind,source=/opt/agsaas/rehearsal-20261101/edge-dependency-build/output,target=/output \
  --mount type=volume,source=agsaas-rehearsal-20261101_deno-cache,target=/root/.cache/deno \
  supabase/edge-runtime@sha256:ad45164b7548bf5820ed7be714789c17ac2865edce79a09cfb4c3756c3d365a8 \
  bundle --entrypoint /home/deno/functions/main/index.ts \
  --output /output/main.eszip --checksum sha256 --timeout 90
```

4. Restart the same rehearsal container in its original internal network.
   Confirm `functions` becomes healthy, `VERIFY_JWT=true`, and a direct
   unauthenticated function request returns HTTP 401. Never disable JWT
   validation to obtain a successful health result. On preparation failure,
   preserve the logs/cache and restart only the previously selected container;
   do not clear the cache or relax runtime networking.
5. The runtime continues to execute `main/index.ts` using the prepared
   `deno-cache`. The generated eszip is a retained build result; it is **not**
   the file passed to runtime startup.
6. Record the image digest, architecture, upstream commit, source hash,
   resolved dependency version and output hashes. Archive the dedicated
   cache while its sole runtime writer is stopped, keep it owner-only and
   verify archive readability. A saved cache artifact is required for
   repeatable recovery: the upstream `@6` range can resolve differently on
   a later online preparation.

For this drill the resolved jose version was `6.2.14`; the cache archive
contains 50 files / 552,960 bytes and has SHA-256
`c6fbd7803cc537b10e1edb7b70d86d7fa8a4881e4d5af4eb138157f538b86c83`.
The source SHA-256 is
`ed402c31abf346198d71cc7bab3b7eead03b91d6b9d638b30fc5e5fada25802b`.
The eszip is 635,676 bytes, SHA-256
`29f9c782fe1f4812d7724769298303feee4c97be94e252038bb2c76fcf925393`.
Private proof and artifacts are under
`/opt/agsaas/rehearsal-20261101/edge-dependency-build/`.

A fresh disposable container booted the main process from a restored copy
of that archive with `--network none` and no application secrets.
Running `bundle` itself offline still attempted to refresh the JSR manifest
and failed; that is not the runtime-start check. Only `main/index.ts` was
prepared here. Imports and execution of dynamically created user functions
need their own explicit preparation and safe invocation checks.

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
