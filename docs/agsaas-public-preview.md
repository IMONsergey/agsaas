# AGSaaS public preview

This installation is an owner-review environment with a fresh database and keys.
It is separate from the original private stage and the completed restore rehearsal.
It does not represent acceptance of every item in the hardening backlog.

## Deployment identity

| Component | Location |
| --- | --- |
| Dashboard | https://94.249.186.240:8543 |
| API | https://94.249.186.240:8544 |
| Supabase API | https://94.249.186.240:8545 |
| Compose project | `agsaas-preview-20261101` |
| Source | `/opt/agsaas/preview-20261101/source` |
| Runtime | `/opt/agsaas/preview-20261101/runtime/supabase` |
| Private operator state | `/opt/agsaas/preview-20261101/control` |
| Platform | Supabase `self-hosted/v0.8.3`, commit `bc27d2661edd09a5d0b8d76ce33da6d4071a756e` |

Nginx binds the three dedicated HTTPS ports and proxies to loopback 3500, 3503
and 4000. TCP 443 remains assigned to Xray; the AmneziaWG service remains separate.
The public Supabase vhost allows only Auth, REST, Storage, Realtime and Functions.
It rejects the gateway root, Studio and Auth admin/invite endpoints. PostgreSQL,
Redis, the worker dashboard and Mailpit have no public listener in this profile.
The access log omits query strings, cookies and authorization headers.

## Login and available integrations

The preview enables only `AUTH_ENABLED_PROVIDERS=password`. Its owner account
is provisioned once through the private Auth admin endpoint and signs in through
the ordinary Supabase password flow. No session is injected into the browser.
Credentials are kept outside Git and are supplied privately to the owner.
The placeholder email address is a login identifier, not a deliverable mailbox.

GoTrue has public signup disabled, email autoconfirm disabled and anonymous/phone
signup disabled. Other installations default to email login; operators must
explicitly enable and configure additional methods. A stale preference cookie
cannot make an unconfigured login provider appear.

External Auth SMTP is not configured for this preview. Product emails use a
separate Resend configuration: `RESEND_API_KEY`, `EMAIL_FROM`, `DASHBOARD_URL`
and optional `APP_NAME`. The standard app Compose passes these values to the
API and worker. Missing configuration fails explicitly; it is not reported as
successful delivery. Bank, payment, AI and external inbox integrations require
the owner's own accounts and credentials before their real end-to-end tests.

The existing manual address fields remain available without Google Places.
A private `vault` bucket supports the existing invoice PDF worker. No browser
Storage policy is added by this preview setup. Generic Vault uploads, exports
and the paused Storage/export work are separate acceptance items.

## Reproduce a new installation

1. Create a clean checkout at the intended full application commit. Use the
   reviewed `prepare-self-hosted.mts` and pinned platform snapshot to generate
   fresh platform and app secrets in a new private runtime directory.
2. Before starting anything, copy `platform.compose.yml`, `compose.apps.yml`
   and `compose.preview.yml`. Select the preview project, source and URLs in
   the private environment; do not use the mail-test overlay. Keep the original
   private-stage/rehearsal guards unchanged.
3. Validate the resolved Compose model in memory. Check every container name,
   volume source, project label and loopback binding. Do not print the rendered
   model: it contains secrets. Start only the 13 platform/cache/queue services.
4. Run `node scripts/self-hosted-preview-db.mts bootstrap` as the deployment
   owner. This fixed-target helper requires a clean matching source revision,
   safe private files, the correct healthy database and data mount, no running
   app writers, and an empty application database. It verifies the exact baseline
   with rollback, then atomically commits the dedicated role, baseline and history.
5. Run the same helper with `upgrade`. It checks the baseline checksum and
   existing migration statements, rejects unknown or out-of-order history,
   and commits each pending reviewed migration together with its history entry.
   Never run the disposable test harness or Drizzle push against this database.
6. Provision only the intended owner account and private invoice bucket. Build
   all three application images from the verified full commit. The dashboard
   must be rebuilt with the public URLs, publishable key and matching Server
   Action encryption key. Runtime-only URL edits do not update browser bundles.
7. Start the API, worker and dashboard. Verify readiness, normal browser login,
   onboarding, reload, customer/project/time workflows and invoice PDF behavior.
   Open only the three reviewed public ports after readiness and TLS checks.
8. Record the actual image IDs, source commit, migrations, TLS expiry and test
   outcomes in the private deployment manifest and the release review. Do not
   infer functional success from container health alone.

## TLS and renewal

This host uses an IP-address certificate from Let's Encrypt with isolated
Certbot 5.4.0 state under the preview control directory. HTTP port 80 serves
only the ACME challenge for the IP vhost; other projects retain their own vhosts.
The dedicated `agsaas-preview-certificate.timer` checks every six hours and
reloads Nginx after successful renewal. It does not replace the system Certbot
installation or another project's certificate job.

IP certificates use the short-lived profile. Monitor the actual expiry and
exercise renewal; an initial valid certificate alone is not a renewal test.
See the official [Certbot IP certificate instructions](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)
and [certificate profile announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability).

## Operations and limits

Stop this project's app writers before schema changes; the helper enforces it.
Keep private snapshots of the database, Storage objects, queue state and keys
before meaningful upgrades. A same-host backup is not disaster recovery; an
independent encrypted backup destination remains a production release gate.
Never print completed environment files, full Docker environment/commands,
provider envelopes, auth sessions or owner passwords into release logs.

The finished restore rehearsal can remain stopped with its data and evidence
retained while this preview runs. Do not remove the original stage, either VPN,
other projects' containers, firewall rules or Nginx configurations.

For invitation retries and finite provider idempotency windows, follow
[the invitation delivery runbook](agsaas-team-invitation-delivery.md).
Keep unresolved outcomes in reconciliation; do not invent a new provider key,
clear first-attempt timestamps or backfill old invitations automatically.
