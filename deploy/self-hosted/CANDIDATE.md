# Exact-release synthetic acceptance installation

**Launch remains blocked until installed protocol and daemon acceptance pass.**
Source now implements a shared quarantine in
`deploy/self-hosted/heavy-slot/`, enforced by the ordinary queue and privileged
adapter. It has not been installed or tested against the real Docker daemon.
The current Desktop Commander policy blocks administrative execution; no
configuration bypass or substitute remote channel is used. Local Python tests
exercise actual process death/flock/queue admission with an explicit fake Docker
transport, not a daemon recovery proof. Review the exact installation and
acceptance in [heavy-slot/README.md](heavy-slot/README.md).

This profile creates **new state only** in `/opt/agsaas/candidate-20261103`.
It never reads the preview/stage environment, database, Storage, Redis or keys.
All seventeen services belong to `agsaas-candidate-20261103`, use an internal
Docker network and independently scoped volumes. No provider credentials, SMTP,
signup, billing or insights are enabled. Auth passwords are strong random fixture
credentials; operator confirmation of synthetic email is not an email-delivery test.

| Service | Public candidate origin | Container host binding |
| --- | --- | --- |
| Dashboard | `https://94.249.186.240:8547` | `127.0.0.1:13500` |
| API | `https://94.249.186.240:8548` | `127.0.0.1:13503` |
| Supabase | `https://94.249.186.240:8549` | `127.0.0.1:14000` |
| Website | `https://94.249.186.240:8550` | `127.0.0.1:13501` |

The candidate's browser/server/PKCE cookie namespace is explicitly
`agsaas-candidate-20261103-auth`. Browser cookies are not isolated by port. The
preview retains its current default until a separately planned session rollout.
The namespace must match at frontend build and server runtime; the preparer
requires it. This prevents candidate login/logout from replacing preview cookies.

## Source and resource ownership

First integrate the complete reviewed source and pass its aggregate gates.
Create a root-owned clean detached checkout at the exact candidate source path
and an empty root-owned `/opt/agsaas/candidate-20261103/runtime` parent. Do not
copy an existing deployment directory. The helper refuses an existing runtime,
occupied loopback ports, pre-existing candidate Docker resources, dirty or
incorrect source, changed platform images, production bind mounts, foreign
volumes, public container ports, host namespaces, privileged containers and
missing memory/CPU/PID bounds.

The public Supabase checkout must remain the clean reviewed commit
`bc27d2661edd09a5d0b8d76ce33da6d4071a756e` at `/opt/agsaas/vendor/supabase`.
Only tracked public configuration is copied. Upstream generators create a fresh
key set with suppressed output. Source, configuration and actual installed
platform image IDs are recorded in a private manifest. This tool never pulls a
runtime image or repairs a pre-existing database.

Use the bounded root adapter after review, not sudo inside imon-job. It holds
the **existing original heavy.lock**, checks its owner/inode, monitors the 8 GiB
disk reserve and limits runtime. CPU/memory/PIDs must also be bounded by the root
systemd unit. These unit limits cover the adapter/CLI, not Docker daemon work.
The root coordinator owns the single heavy slot; the separate builder gate below
is required before `prepare` can create any new runtime state.

```sh
# Replace FULL_MERGED_SHA with the tested exact source commit, not a branch/tag.
sudo -n systemd-run --unit=agsaas-candidate-launch-20261103 --collect --wait \
  --property=CPUQuota=200% --property=MemoryMax=3G --property=MemorySwapMax=0 \
  --property=TasksMax=256 --property=TimeoutStartSec=150min \
  --property=TimeoutStopSec=5min \
  /usr/bin/python3 /opt/agsaas/candidate-20261103/source/scripts/self-hosted-admin-job.py \
  candidate --candidate-action launch --timeout 7200 --lock-timeout 600 \
  --release FULL_MERGED_SHA \
  --redis-image redis@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f
```

`launch` is the fixed sequence `prepare → platform → bootstrap → build → start
→ seed`. It initializes the actual pinned Auth and Storage catalogs, stops only
candidate writers, verifies the baseline with rollback, rehearses the complete
ordered incremental migration chain, then commits that whole installation in
one transaction. Four application images build sequentially with the exact
release labels and candidate origins. The native worker starts only after the
database and image provenance gates pass. Completed synthetic accounts are
recorded only in `/opt/agsaas/candidate-20261103/synthetic-browser-credentials.json`
(root, mode 0600); no credential is printed. Accounts have no seeded business
records: initial team setup can be exercised through the real interface.

Individual fixed actions allow an operator to inspect `config`/`status`, resume
a known next phase or `stop` all candidate services while retaining its data.
An ambiguous failed mutation is never retried automatically; the private
manifest and real catalog determine the next step. `prepare` cannot overwrite
state or rotate keys. A later source retarget/migration requires a reviewed
procedure; changing an environment SHA alone is not a deployment.

## Daemon-side build resource gate

`prepare` and each application build inspect the dedicated, single-node local
`docker-container` builder `agsaas-candidate-20261103`. The container must be
`buildx_buildkit_agsaas-candidate-202611030`, use an approved **digest-pinned**
`moby/buildkit` image, its own state volume and bridge network. Actual Docker
HostConfig must cap memory at 3 GiB, total memory+swap at the same value, CPU at
2 cores and PIDs at 256. The manifest records its container ID, image ID and
limits; a replaced or modified builder fails closed. Builds explicitly select
this builder with `docker compose build --builder`; unsupported local versions
fail before an application starts.

The builder is **not known to exist on the server**. Its reviewed installation,
using an approved image digest already available to that host, is an outstanding
prerequisite. Do not substitute an invented digest or `latest`. Provision its
Buildx node only in a bounded root administration operation holding the existing
heavy lock. Relevant driver options are `image`, `memory=3g`,
`memory-swap=3g`, `cpu-period=100000`, `cpu-quota=200000`, `network=bridge`,
`default-load=true` and `restart-policy=no`. Buildx does not advertise a
`pids-limit` driver option: set `docker update --pids-limit 256` on this exact
new builder container after boot, then inspect all actual limits. It must be
running for standalone preparation. After a durable quarantine, the reviewed
adapter starts only the already verified exact container ID for launch/build;
it never creates or pulls a substitute builder.

The adapter arms the root-owned shared quarantine **before** starting the exact
builder or candidate child. Both the ordinary queue and privileged adapter
check that marker after acquiring the original lock. A waiting ordinary job
releases the lock and stays queued while quarantined, allowing recovery to
acquire it. Malformed or partially written markers also block admission.

SIGKILL closes the process lock but leaves the durable quarantine, so compatible
runners cannot admit a competing heavy operation. Normal cleanup and explicit
`candidate --candidate-action recover-builder` independently inspect the exact
container/image and confirm it stopped, then update the candidate manifest and
clear the shared marker. Docker failure, changed container identity or cleanup
failure retains quarantine. There is no age-based release. Completed recovery
receipts remain in the root-owned control directory.

Before arming, the adapter verifies the installed queue hash/protocol and refuses
any pre-protocol queued/running process. Updating the script cannot update an
already running Python interpreter; existing jobs must finish naturally before
candidate acceptance. No existing runner is stopped or restarted by installation.
The TypeScript launch/build paths require the current adapter parent PID and
operation token plus the exact matching builder receipt.

Real daemon-unavailable, cleanup-exception and SIGKILL tests are still required
with a harmless synthetic builder job and a competing queued sentinel, proving
no competing admission until independent recovery. The reviewed source does not
by itself establish that this protocol is installed or that Docker stop behavior
was accepted. Actual queue policy, socket access and the original lock ownership
remain unchanged.

The daemon's image import/export and filesystem cache remain outside the CLI
cgroup; the shared 8 GiB disk-reserve monitor remains necessary. Measured
resource acceptance has not been performed.

Application Dockerfiles pin Bun 1.3.11 and Node 24.21.0-trixie-slim to the
verified OCI index digests in `base-image-receipt-20261103.json`. The receipt
also records their Linux amd64 manifests and a real BuildKit v0.34.1 digest.
Registry metadata was verified over HTTPS; no image was pulled or built by that
source change. The BuildKit choice includes the latest official stable patch
observed in the [upstream release](https://github.com/moby/buildkit/releases/tag/v0.34.1).
This pins base content, not every build input: apt package repositories and
network-fetched dependencies still require controlled build acceptance/cache.
A dedicated BuildKit may need approved registry/dependency access; preinstalled
Docker runtime images do not automatically populate its independent cache.

Reference: Docker's [docker-container driver options](https://docs.docker.com/build/builders/drivers/docker-container/)
and [Compose build options](https://docs.docker.com/reference/cli/docker/compose/build/).
In particular, Compose `--memory` does not constrain BuildKit.

## Host ingress

After local readiness and exact release proof pass, the separately selected
`candidate --candidate-action ingress` adapter operation installs the reviewed
`nginx.candidate.conf` as its own new host vhost file. It refuses an existing
different file, requires all seventeen services running and every defined healthcheck healthy, checks `nginx -t`
before reload and verifies actual trusted HTTPS/noindex responses on all four
ports plus the public-image response protections. Failure rolls back only its
newly created configuration and checks/reloads the prior setup. An unchanged
existing candidate file is never removed as error cleanup. Root coordinates any
narrow firewall opening for 8547–8550 and
the external browser handshake. Ports 443/VPN and preview 8543–8546 are outside
this file. The existing valid IP certificate stays on the host; it is never
mounted into a candidate container.

Noindex applies to every candidate response. Supabase administration/Studio is
not exposed. Public image responses have `nosniff` and
`Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`.
The actual served certificate, response headers and external browser access
must be checked after installation; a valid local Nginx configuration alone is
not proof that a firewall or remote browser can reach it.

The ingress action accepts **neither** `--release` **nor** `--redis-image`.
Only prepare/launch receive those two arguments. After the runtime/source gates:

```sh
sudo -n systemd-run --unit=agsaas-candidate-ingress-20261103 --collect --wait \
  --property=CPUQuota=100% --property=MemoryMax=512M --property=MemorySwapMax=0 \
  --property=TasksMax=128 --property=TimeoutStartSec=20min --property=TimeoutStopSec=4min \
  /usr/bin/python3 /opt/agsaas/candidate-20261103/source/scripts/self-hosted-admin-job.py \
  candidate --candidate-action ingress --timeout 180 --lock-timeout 600
```

The Node binary in the adapter remains `/opt/imon-runtime/node/bin/node`.
The candidate fresh-environment rejection now also covers `ENABLE_BANKING_`,
`COMPOSIO_`, `MISTRAL_`, `LOGO_DEV_`, `R2_`, company enrichment, alternate model
providers and public analytics configuration. Generated own Supabase and support
intake secrets remain installation-local and are not provider credentials.

## Upload contract and acceptance

`20261103093100_storage_bucket_access.sql` depends on the actual active-session
function from `20261103071000_auth_session_revocation.sql`, the MFA helper and
native Storage metadata projection. It creates a private 50 MiB `vault` bucket
and new intended-public raster-image buckets `avatars`/`apps`, limited to 5 MiB
and JPEG, PNG, WebP or GIF. No SVG, HTML or financial document belongs in an image
bucket. Existing incompatible bucket visibility/settings fail closed; this
migration does not make an existing private bucket public.

| Bucket | Object namespace | Browser write permission |
| --- | --- | --- |
| vault | `<team UUID>/…` | Current team member |
| avatars | `users/<user UUID>/<random UUID>.ext` | That user |
| avatars | `teams/<team UUID>/logo/<random UUID>.ext` | Team owner |
| avatars | `teams/<team UUID>/invoice/<random UUID>.ext` | Team owner |
| apps | `<team UUID>/logos/<random UUID>.ext` | Team owner |
| apps | `<team UUID>/screenshots/<random UUID>.ext` | Team owner |

Every write checks an active owned Auth session and authoritative MFA. Public
asset objects cannot be updated/replaced, including under a future permissive
policy; each UI upload uses a fresh UUID name. Private bytes cannot be moved
into a public bucket. Display assets keep real public URLs for the profile,
company, invoice portal and app listing. Each upload control explains “Visible
to anyone with the image link.” Storage API bucket limits enforce content type
and size; these are not claims of an antivirus or content-scanning service.

Run these on the merged branch through the normal queue before launch:

```sh
bun --no-env-file test --exit packages/supabase/src/client/cookie-namespace.test.ts
bun --no-env-file test --exit scripts/self-hosted-candidate.test.ts scripts/self-hosted-candidate-resources.test.ts apps/dashboard/src/utils/public-image-upload.test.ts
bun test --exit packages/db/src/test/mfa-assurance-postgres.test.ts
bun test --exit packages/db/src/test/storage-document-ingestion-postgres.test.ts
bun test --exit packages/db/src/test/storage-bucket-access-postgres.test.ts
```

The PostgreSQL tests use the isolated loopback `midday_test` connection and real
RLS with separate users/sessions; they apply the actual 071000 function, never
a constant-true assurance bypass. They cover another tenant, member vs owner,
MFA AAL1/AAL2, revoked/missing/another user's session, banned/deleted Auth users,
lost membership, traversal aliases, anonymous denial, a malicious permissive
policy, immutable image updates and preservation of existing private buckets.
The SDK test uses actual SSR clients sharing a cookie jar and verifies independent
sessions/local logout. The candidate config tests reject deployment escapes.

Then use the isolated real UI/API to create the initial team, upload/download a
CSV and an attachment, observe the native Vault document projection, and display
each raster-image type in its actual UI and invoice portal. Confirm 5 MiB and SVG
rejection, asset response headers, second-tenant denial and cleanup of only the
synthetic fixtures. Native byte-store/HTTP/UI acceptance remains a separate gate
from SQL policy correctness. Bank, email/OAuth, billing and AI-provider end-to-end
acceptance remains gated by real configuration, not synthetic success.

## Infrastructure ledger still requiring operational evidence

The cold-backup synthetic Docker test passed fourteen checks in 197.18 seconds,
including real PostgreSQL recovery, Storage bytes, Redis AOF and failure recovery.
It does not prove production PostgreSQL17/Supabase recovery or an offsite copy.
Current independent storage capacity fails the complete recovery-bundle reserve
gate; never prune unrelated backups to hide that problem. No backup timer has
been activated. TLS dry-run/observed rotation, an authenticated monitored canary
with an actual alert route, measured candidate load/resource margins, production
headers, key lifecycle/rotation recovery and own website 8546 rollout retain
their explicit operational gates. Native bank/onboarding ownership also remains
open until the merged durable runners and real provider acceptance pass.
