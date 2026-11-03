# Own website, ingress and release evidence

The reviewed provisional website origin is `https://94.249.186.240:8546`.
The dashboard/API/Supabase stay on 8543/8544/8545. The website binds only
`127.0.0.1:3501` behind the host's Nginx. The source package adds no listener on
443 and makes no DNS, firewall, certificate or VPN change by itself.

DNS checked on 2026-11-03 points `imon.world`/`www.imon.world` at 95.163.244.138;
`agsaas.imon.world`, `app.imon.world` and `api.imon.world` do not resolve. These
names must not be presented as configured AGSaaS origins. A domain migration
needs the authorized DNS/ingress route, updated Auth callbacks and rebuilt public
frontend URLs. The IP certificate already covers the provisional website's IP;
its validation and renewal must be proven before publication.

## Build and packaging

Merge the root website source changes (standalone output, own-origin helpers,
honest capability pages and noindex defaults) before using `apps/website/Dockerfile`.
The image uses native Node 24.21.0 and Bun 1.3.11 for frozen dependency installation.
It requires the exact matching `GIT_COMMIT_SHA`/`NEXT_PUBLIC_RELEASE_SHA` and own
HTTPS website/dashboard/API origins. Runtime-only URL edits do not retarget a
built Next frontend. No Supabase server key or other provider credential is a
website build argument. The runner is non-root and has bounded memory/CPU/PIDs.

Add `compose.public.yml` as the last owned overlay. Set `AGSAAS_WEBSITE_URL` and
the exact integrated `AGSAAS_RELEASE` in the existing private deployment config.
`AGSAAS_SITE_INDEXABLE` stays false. Validate the complete merged Compose privately
with `config --quiet`; a rendered config contains other services' credentials.
Builds run through the shared resource policy. First verify localhost website
`/api/health/`, including exact release, then review/install `nginx.public.conf`,
run `nginx -t` and apply the narrow 8546 exposure through root coordination.

The Nginx website vhost enforces HTTPS, rejects another Host, omits query strings
from access logs, limits body size and supplies a same-origin CSP and preview
noindex header. CSP permits Next's inline scripts/styles but no external script
origin or eval. Verify the real pages in a browser after promotion. HSTS does not
persist for IP literals; a real owned hostname and its HTTPS acceptance are
required before claiming that protection. The vhost intentionally avoids an
unreviewed HSTS preload/includeSubDomains policy.

## Release provenance

API, worker, dashboard and website Dockerfiles explicitly override inherited OCI
revision/source labels. `self-hosted-release-proof.py --project PROJECT --release
FULL_SHA --website` reads only the actual running image ID, these labels and the
runtime stamp `/tmp/git-sha.txt`. It fails if a base-image revision or older
backend stamp is accidentally represented as the new full release. It does not
infer exact source provenance from a mutable tag. Record this receipt alongside
the tested SHA and migration history after the integrated images start.

## TLS acceptance and renewal

`self-hosted-tls-check.py check` performs trusted handshakes on the owned ports,
validates the IP SAN through normal hostname verification and reports actual
served certificate fingerprints, TLS versions and remaining lifetime. The
default alert threshold is 36 hours for this short-lived certificate. Add 8546
to the port list only after website ingress exists.

The explicit `renew-dry-run` action exercises the existing isolated Certbot
5.4.0 installation and state. It does not claim that a production leaf rotated.
The `reload` deploy hook compares certificate/key public keys, checks expiry and
Nginx configuration, reloads Nginx and proves that all selected endpoints serve
the leaf currently on disk. The receipt distinguishes a successful reload from
an observed fingerprint rotation. The optional systemd drop-in retains the
existing six-hour timer and Certbot state; root must review/install it. No hook,
timer or renewal has been applied by adding this package.

## A real business canary

`self-hosted-canary.py` supports a public-only check of the website release,
login page and API dependency readiness. Its receipt explicitly says
`authenticatedBusinessVerified: false` in that mode.

Full mode requires a private operator-supplied dedicated account/team and
`allowMutations: true`. It signs in through the actual Auth endpoint, verifies
tenant access through RLS, uploads one unique small Vault object, downloads and
compares its bytes, checks the native Storage-to-document projection and removes
the object and metadata in `finally`. It signs out only its own newly created
session. It uses no service-role key, creates no account, sends no email and
does not pretend an unconfigured provider is available. No credentials are
included in receipts. A failed cleanup reports only the exact synthetic path
that an operator must reconcile. Redirects are rejected so an old upstream
redirect cannot carry credentials to a different origin.

Queue full canaries with a bounded 180-second timeout and a mode-0600 config.
Do not point the template at a real team's data until its scope is deliberately
selected. Run the first full canary only after the native metadata migration is
applied. Add monitoring only after a real account, alert destination and tested
cleanup exist; public HTTP 200 is insufficient to close the business-health gate.
Financial workflows, email delivery, provider consent and paid subscriptions
retain their own acceptance tests and real-provider gates.
