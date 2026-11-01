# Durable team invitation email

New invitations use the self-hosted BullMQ `teams` queue. The API writes the
invitation and its delivery intent in one PostgreSQL transaction, then attempts
a bounded queue wake-up. Redis is not the durable record. The API returns
`queued`, and the dashboard distinguishes a queued email, provider acceptance,
a permanent provider rejection and an operation that needs review.

## Configuration and rollout

Apply `20261101080254_durable_team_invitation_delivery.sql` from
`packages/db/self-hosted/upgrades/supabase/migrations` in the normal upgrade
sequence before starting the corresponding application revision. The migration
adds a backend-only delivery table and a composite invitation/team key. It does
not rewrite the bootstrap baseline or create email intents for old invitations.

The API and worker require explicit `RESEND_API_KEY`, `EMAIL_FROM` and
`DASHBOARD_URL` for new invitation mail. `APP_NAME` defaults to `AGSaaS`.
`DASHBOARD_URL` is the application's HTTPS origin (HTTP is accepted for local
loopback development). The sender and URL cannot use the upstream Midday
domain. The sender must be usable by the configured Resend account. There is no
fallback to an upstream sender. Missing configuration rejects creation before
the API writes an invitation; a worker whose configuration is unavailable
defers an already committed intent without starting its provider retry window.
Supabase Auth SMTP is a separate configuration and transport.

Stop or reconcile pre-switch Trigger.dev invitation tasks as part of the
rollout. Their existence does not constitute an idempotent provider receipt.
The new recovery scanner only discovers explicit new delivery rows, so an old
pending invitation is shown as having no recorded email delivery. Do not
backfill those rows or blanket-resend old invitations.

## Delivery and recovery

Each new invitation has exactly one initial delivery row. The worker rechecks
the invitation's tenant and the inviter's current membership and role before
claiming a send. The existing rule remains: members can invite members; only
owners can invite owners. Acceptance still requires the signed-in user's
trusted email address to match the invitation. Removing or accepting an
invitation deletes its unneeded delivery row. An HTTP request already in flight
cannot be recalled by that deletion.

Before the first provider request, the worker renders and persists the exact
provider body and its SHA-256 hash. Retries reuse those bytes and the stable
key `agsaas-team-invite/<delivery-id>`, including after a template, team name or
runtime setting changes. The Redis payload contains only team, invitation and
delivery UUIDs. Recipient addresses and rendered HTML are not queue payloads or
failure text.

The claim has a 120-second SQL lease; the provider request has a 30-second
timeout. A lost response, timeout, 429 or uncertain provider failure is retried
with the same operation. A once-per-minute scheduler scans due SQL intents,
including when the original queue wake-up was lost. It processes at most 25
rows per pass and isolates one row's failure from the rest.

An actual nonempty provider message ID is required for `accepted`. That state
means the provider accepted the request, not that the recipient's mailbox
delivered it. Acceptance persists its time and provider ID, clears the stored
HTML and prevents another automatic send. A permanent rejection becomes
`rejected`; a body/key conflict or integrity violation becomes
`reconciliation`.

Automatic replay stops before 23 hours from the first attempt, after 12 claims,
or if the database clock/chronology is inconsistent. These are finite bounds
around the existing Resend idempotent transport, not a promise of indefinite
exactly-once email. Do not reset attempts or first-attempt timestamps, change
the key, or remove the journal to force a resend. Review provider records and
the invitation state before choosing an explicit follow-up action. New SMTP
delivery would require its own honest uncertainty and recovery model.

## Verification

The added tests cover real PostgreSQL atomic insertion and rollback, concurrent
deduplication/claims, tenant scope and composite FK enforcement, membership and
role changes, finite retry bounds, receipts and envelope removal, and the
exact incremental migration with browser-role access denied. Legacy invites
are explicitly tested as having no recovery delivery.

Notifications tests exercise the real email template, renderer and Resend SDK
with intercepted HTTP and blocked live network. They simulate provider
acceptance followed by response loss, failure to persist a receipt, concurrent
delivery, settings changes between retries, malformed receipts and provider
errors. Worker and API tests cover durable IDs, recovery isolation, permanent
versus retryable outcomes, bounded Redis failure and honest queued responses.
Run the registered repository unit tests and disposable PostgreSQL suite; a
live provider credential or a real recipient is not required by these tests.
