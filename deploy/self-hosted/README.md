# Private self-hosted stage

These files prepare an isolated AGSaaS stage alongside an actual self-hosted
Supabase. There is no Payload dependency. This is not a declaration that all
business features or a public production deployment have been verified.
This guide describes intended configuration, not current server health. A
successful deployment, working sign-in or external mail delivery must be verified
separately; the presence of these files is not evidence of those outcomes.

The first stage publishes only loopback ports. It does not replace the existing
services on the host, bind public port 443, alter the VPN, or expose PostgreSQL,
the pooler, Redis, worker administration, or a Docker socket.
Inventory occupied ports and existing containers before every installation or
recovery action. Limit start/stop/recreate commands to the `agsaas-stage` project
and its owned paths/volumes; existing VPN and other unrelated services are outside
this deployment's scope. Never resolve a port conflict by stopping another service.

## Matched platform snapshot

Use the complete official
[self-hosted/v0.8.3 release](https://github.com/supabase/supabase/releases/tag/self-hosted/v0.8.3)
at commit `bc27d2661edd09a5d0b8d76ce33da6d4071a756e`. Preserve its Compose file,
`volumes/`, initialization SQL, helper scripts and image versions together.
The overlays do not substitute independent Supabase image versions. Record the
resolved image digests with the deployment manifest as well as the source commit.

This snapshot uses Envoy (`api-gw:8000`), Supabase PostgreSQL 17, and the new
publishable/secret API-key configuration. The original gateway and pooler publish
host ports, and the original containers have fixed global names. Therefore the
base file is **not safe to start alone** on a shared host.

Layer the files in this order:

1. Installed upstream `docker-compose.yml` under `/opt/agsaas/runtime/supabase`.
2. This directory's `platform.compose.yml`.
3. Optionally, `compose.mail-test.yml` for the explicitly private OTP test stage.
4. This directory's `compose.apps.yml`.

The project is `agsaas-stage`. Platform containers receive explicit stage-specific
names; application containers and named volumes use the Compose project prefix.
Realtime retains its `realtime-dev` tenant prefix and the upstream DNS alias
`realtime-dev.supabase-realtime` inside this isolated network.

`!override` replaces the upstream gateway port list rather than merging with it.
`!reset` removes both pooler host mappings and any database host mapping. Use a
Compose version supporting these tags; the inspected target has Compose 2.40.3.
Do not remove these tags to make an older parser accept the file. A local YAML
parser test cannot prove the effective Docker Compose merge.

## Files, credentials and URLs

The server preparer installs the matched platform under
`/opt/agsaas/runtime/supabase` and the application checkout under
`/opt/agsaas/source`. Use `app.env.example` as an inventory, not as usable
credentials. Generate real environment files with mode 0600, outside version
control. A single combined environment or two ordered environment files work;
the app template deliberately does not overwrite the platform keys with blanks.

The preparer is for a **new runtime only** and refuses an existing destination.
It rejects ignored/untracked state in the vendor Docker tree before copying.
The copy includes only Git-index-listed regular files. It normalizes public
upstream files from Git modes: `100644` becomes `0644`, and `100755` becomes `0755`;
public directories are created as `0755`, with the runtime root kept at `0750`.
Do not infer permissions from source filesystem modes: a clone made under umask
`0077` can have unreadable `0600` SQL and `0700` directories while Git looks clean.
Only the public copy uses umask `0022`; the preparer restores `0077` before
generating private keys and writes `.env` as `0600`.
Do not apply recursive permission changes to the runtime: database data,
generated keys and public static assets have different requirements. Do not rerun
fresh preparation to repair an existing deployment or rotate its keys.

Generate the platform keys using that snapshot's official key-generation scripts.
The signing/verification JWKs, asymmetric API JWTs and opaque API keys must belong
to the same generated set. The overlay fails when required key variables are
empty rather than silently reverting to an incompatible gateway configuration.
Do not echo generator output, completed environment files, tokens, OTP messages,
or a fully rendered Compose configuration into CI logs.

| Setting | Private-stage value / rule |
| --- | --- |
| `AGSAAS_SOURCE_DIR` | `/opt/agsaas/source` |
| `AGSAAS_RELEASE` | Full application Git commit, used for all three image tags/build stamps |
| `AGSAAS_DASHBOARD_URL` | `http://localhost:3300` |
| `AGSAAS_API_URL` | `http://localhost:3303` |
| `SUPABASE_PUBLIC_URL` | `http://localhost:3800` |
| `API_EXTERNAL_URL` | `http://localhost:3800/auth/v1` — this release includes the Auth path |
| `SITE_URL` | `http://localhost:3300` |
| `POOLER_TENANT_ID` | `agsaas-stage` |
| `AGSAAS_DATABASE_URL` | Dedicated `agsaas_app` role, internal `db:5432`, database `postgres` |
| `AGSAAS_WORKER_DATABASE_URL` | `agsaas_app.agsaas-stage` via internal `supavisor:6543` |
| `AGSAAS_REDIS_IMAGE` | Approved immutable Redis reference; the repository tests the Redis 7.4 line |
| `AGSAAS_CADDY_IMAGE` | Approved immutable Caddy reference, only for the optional mail-test overlay |
| `AGSAAS_WORKER_ENV` | `staging` until the worker's production behaviors/providers are deliberately enabled |
| `NEW_USER_SIGNUP_CUTOFF` | Unset by default; an explicit ISO timestamp is optional |

Provision the dedicated database role and real application baseline before the
applications start. Do not use a runtime `postgres`/`supabase_admin` connection,
the calculation-test SQL, synthetic auth functions, or test tracker stubs as a
production bootstrap. URL-encode database credentials. `sslmode=disable` in the
private connection examples is limited to this same-host Docker network; it is
not a configuration for a public/external database.

Generate separate persistent values for `REDIS_CACHE_PASSWORD`,
`REDIS_QUEUE_PASSWORD`, `INTERNAL_API_KEY`, `MIDDAY_ENCRYPTION_KEY`,
`FILE_KEY_SECRET`, and `INVOICE_JWT_SECRET`. Use 64 hex characters for these
stage-generated secrets; in particular the AES key requires exactly 32 bytes
and the Redis passwords must be URL-safe. `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
instead requires canonical base64 of 32 random bytes. Reuse it at image build
and runtime, and across replicas of that release. Do not regenerate encryption
or signing keys on each restart or overwrite an existing deployment's keys.

The canonical public Supabase URL remains the SDK base URL on browser and server.
The app overlay supplies `SUPABASE_INTERNAL_URL=http://api-gw:8000` for the
server-only HTTP transport. This requires the corresponding application transport
support; simply changing `NEXT_PUBLIC_SUPABASE_URL` to a Docker hostname breaks
browser URLs and cookie identity. `localhost:3800` without that server transport
override points at the wrong container during SSR. Worker/API communication uses
`API_INTERNAL_URL=http://api:8080`, while shared link helpers receive explicit
`API_URL`/`DASHBOARD_URL` values to avoid upstream deployment defaults.
`SUPABASE_INTERNAL_URL` is optional outside this private Docker deployment. Leave
it empty when the canonical Supabase endpoint is already reachable from the server;
when set, use an HTTP(S) base URL without credentials, query or fragment. It is
server-only runtime configuration, never a `NEXT_PUBLIC_*` variable or a replacement
for the browser's canonical URL. The offline runtime doctor checks this optional
setting for API, worker and dashboard, but does not contact the endpoint.

Public frontend URLs and the publishable key are build inputs. Changing only
runtime environment variables does not retarget an existing dashboard image.
Never pass server-side Supabase/provider credentials as `NEXT_PUBLIC_*` values.
The existing dashboard Dockerfile passes the Server Actions key as a build
argument: keep build logs, intermediate caches and release artifacts private;
do not put provider secrets in build arguments. The unchanged Google Font loader
still needs outbound font access during a clean dashboard build.

## Ports and first verification

| Service | Host binding | Container endpoint |
| --- | --- | --- |
| Dashboard | `127.0.0.1:3300` | `dashboard:3000` |
| API | `127.0.0.1:3303` | `api:8080` |
| Supabase | `127.0.0.1:3800` | `api-gw:8000` |
| Optional Mailpit UI | `127.0.0.1:3825` | `mailpit:8025` |

An authorized operator can forward the matching local ports through SSH. Use
`localhost` consistently with the configured origins, not an arbitrary server IP
or a different browser hostname. Do not expose these HTTP endpoints by replacing
`127.0.0.1` with `0.0.0.0` to make remote access convenient.

Before starting anything, verify the project name, source commit, effective port
bindings, unique container names and mount roots. Use `docker compose config --quiet`
for syntax validation with the complete ordered file/environment list;
inspect any fully rendered configuration privately because it contains secrets.
Only an explicitly authorized operator runs Docker or modifies the server.

Readiness checks are `/health/ready` for API and worker; `/health` remains
liveness. Dashboard `/api/health` tests the web process, not authentication.
The application healthchecks are bounded and the stop grace periods allow the
existing API/worker cleanup deadlines to finish. These endpoints do not validate
RLS, first-user creation, storage policies, migrations, paid providers, or jobs.
After core startup, separately verify a real authenticated flow and the actual
application schema against the real Supabase instance.

## Optional captured-email OTP test

Read the official
[custom email template guide](https://supabase.com/docs/guides/self-hosting/custom-email-templates).
Auth fetches templates over HTTP; mounting an HTML file into the Auth container
does not configure it. The fresh-runtime preparer copies this directory's
`templates/otp.html` into the installed snapshot's `volumes/templates/`.
These non-secret assets require directory mode `0755` and file mode `0644` so
the restricted container can read them across UIDs. Preserve those exact modes
if installing the template manually; do not make `.env`, signing keys or rendered
OTP messages publicly readable. The private Caddy service serves `otp.html`
to Auth, which renders the real `{{ .Token }}`
for confirmation and passwordless-login messages. Missing template files fail
the template service's healthcheck instead of silently claiming OTP support.

Caddy still listens only on internal HTTP port 8080 with no published host port.
Its official binary carries a `NET_BIND_SERVICE` file capability, so the overlay
drops all other capabilities but retains that one to allow the binary to execute.
`no-new-privileges` remains enabled; privileged mode and DAC bypass are not granted.

The separate Mailpit overlay pins the verified v1.32.0 image digest. It retains
at most 1000 captured messages, accepts at most 1 MB per message, disables
automatic version checks and reverse DNS lookups, and configures no forwarding,
relay server or webhook. SMTP 1025 and the template server are not host-published.
Only the Mailpit UI/API is available on loopback 3825. Its message database is
temporary; restarting/removing the capture service discards test mail.

This proves real Auth-generated SMTP transport and OTP verification only after
the corresponding tests pass. It does **not** send mail to the recipient's real
mailbox. Email auto-confirm and phone auto-confirm remain disabled. Without this
explicit overlay or a configured real SMTP service, no email-delivery claim is
made. Treat captured OTPs as sensitive; do not print message bodies or expose the
capture UI to untrusted users.

After the application baseline and API are ready, the closed-stage HTTP runner
can exercise the real instance. Node 24 reads the private environment file
directly; do not export or print its contents:

```sh
node --env-file=/opt/agsaas/runtime/supabase/.env \
  /opt/agsaas/source/scripts/self-hosted-smoke.mts --allow-test-writes
```

The explicit flag authorizes identifiable synthetic records in this private
stage. The runner refuses non-loopback destinations, redirects, non-publishable
API keys, an unexpected Mailpit label, enabled mail forwarding, or auto-confirm.
It creates two `smoke-UUID@example.test` identities using real SMTP OTPs, checks
Auth-created profiles through PostgREST, creates each first team through tRPC,
and verifies tracker arithmetic and denial of cross-team reads/switches.
Customer access is read-only so it does not enqueue enrichment or call optional
providers. It does not exercise banking, Storage or external email delivery.

The report contains safe check names and fixture UUIDs, not OTPs, tokens or mail
bodies. Fixtures are retained intentionally: the existing account/team deletion
routes can call external providers. Failed mutations are never automatically
retried, and a successful report is not a browser-cookie/production-HTTPS test.
The runner's offline regression suite includes native Node HTTP fixtures; those
fixtures validate the runner itself and are not real Supabase integration evidence.

## Persistence, limits and rollback

The matched platform retains PostgreSQL data, Storage files, `db-config` key
material and its other upstream volumes. Queue Redis additionally uses the
project-scoped `redis-queue-data` volume, AOF with one-second fsync, and
`noeviction`. Cache Redis is separate and may evict entries; it does not persist
its disposable cache. Queue exhaustion must produce an alert/failed write, not
silently delete jobs. AOF does not guarantee zero data loss on host failure.

The private stage sets explicit container memory/CPU/PID/log limits, not a
production capacity guarantee. The base platform plus app limits sum to about
11.9 GiB; the optional mail-test services add 384 MiB. Monitor actual headroom,
OOM events, Redis memory/AOF growth, database pool waits and job failures before
increasing load. Supavisor bounds each server-side pool to 10 connections and
accepts up to 80 clients per pool, with a separate five-connection metadata pool.
The current worker Node pool can still have up to 50 *client* connections; no
unsupported Node pool-size environment setting is invented here.

Backups need a consistent PostgreSQL backup, Storage object files, stable
encryption/signing keys, the deployed configuration/manifest and an intentional
queue recovery plan. An SQL dump alone omits stored object bytes. Store encrypted
backups off this server and prove restoration into a separate namespace before
accepting valuable data. Retention and an off-host destination require an
operator decision; this profile does not silently provision a backup service.
No scheduled off-host backup, retention policy or successful restore is implied
by the Compose files. A copy of live PostgreSQL data files is not a substitute for
a consistent database backup. Keep recovery copies separate from active volumes,
preserve their access restrictions and verify restores without altering the
existing services on this host.

Never run the upstream destructive reset script, `docker system prune`, a global
Redis flush, or `compose down --volumes` as a deployment/update step. Normal
application rollback reuses previous image digests and preserved keys; database
and Storage migrations require a separate compatibility/restore decision.
The pinned Storage release documents one-way migrations, so swapping its image
back is not a safe database rollback.

## Gates before public production

- Choose owned domain names, DNS, valid HTTPS and an authorized ingress plan.
  Public 443 is already used by the host's VPN and is not part of this stage.
- Rebuild the dashboard with the final HTTPS application/API/Supabase URLs;
  align Auth `API_EXTERNAL_URL`, `SITE_URL`, redirect allowlists and CORS.
- Remove the mail-test overlay, configure real SMTP, verify actual delivery and
  the intended production templates, and keep auto-confirm disabled.
- Verify the real application baseline, registration/profile/team creation,
  authorized queries and representative storage/job flows. A startup smoke is
  not a substitute for these checks.
- Configure only the providers actually offered to users, run a restore drill,
  review operational limits and alerting, and record the exact release/digests.

## Local contract tests

From the repository root, without Docker or network calls:

```sh
bun test --exit deploy/self-hosted/config.test.ts
```

These inspect declared wiring, required secrets, loopback bindings, persistence,
limits and the mail-test boundaries. They do not start containers, apply SQL,
verify credentials, or replace validation of the merged deployment on the target.
