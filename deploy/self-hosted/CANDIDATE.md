# Exact-release synthetic acceptance installation

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
systemd unit. The root coordinator owns the single heavy slot.

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

## Host ingress

After local readiness and exact release proof pass, the separately selected
`candidate --candidate-action ingress` adapter operation installs the reviewed
`nginx.candidate.conf` as its own new host vhost file. It refuses an existing
different file, requires all seventeen services to be healthy, checks `nginx -t`
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
bun --no-env-file test --exit scripts/self-hosted-candidate.test.ts apps/dashboard/src/utils/public-image-upload.test.ts
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
open until its durable runner and provider acceptance are implemented.
