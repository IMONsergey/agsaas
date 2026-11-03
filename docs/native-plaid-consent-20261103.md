# Native Plaid consent: server and dashboard review checkpoint

This is a source implementation awaiting queued type, unit, PostgreSQL, UI and
real-provider acceptance. No provider request or migration was executed while
authoring it. The legacy banking/token endpoints and the other three providers
remain closed. The dashboard entry point is implemented in a separate UI
follow-up; operator resolution UI is still outstanding.

The separate `bankConsents` router derives owner, team, current session and AAL
from verified context. Strict request objects accept only command/intent UUIDs
and US/CA country selection. The server retains an encrypted Link capability,
retrieves proof for that exact Link token, durably claims its one-use exchange,
retains the resulting access credential before additional provider reads, and
atomically commits verified accounts, a redacted audit event and native SQL sync.
Unverified balances remain null. The SQL authorization and expiry checks run
again after provider IO; expiry uses the database clock even after lock waits.

Each command's provider transport has one 30-second monotonic budget, a maximum
15 seconds per request, a fixed Plaid origin, rejected redirects and a 2 MiB
response limit. It performs no automatic create/exchange retry. Signed Hosted
Link webhooks are acknowledged without accepting, logging or exchanging their
tokens; completion requires the initiating owner's server verification flow.

Known abandoned/revoked grants use the existing durable cleanup. That worker
now requires the original environment/client binding for native grants before
provider IO, including after profile/team deletion. Missing SQL, ciphertext or
configuration defers cleanup. A lost create/exchange outcome or abandoned grant
without a usable revoke credential remains `reconciliation`. It is never
reported as canceled and currently blocks further Plaid consent for that team
until provider review. There is deliberately no unsafe automatic clearing path.

Apply the separately reviewed append-only migration
`20261103111000_plaid_hosted_consent.sql` before deploying these worker/API
changes. Existing SQL files and the foundation source lock were not changed.
The root coordinator owns migration rehearsal/application and every heavy job.

Optional enablement requires `AGSAAS_PLAID_HOSTED_LINK_ENABLED=true`, explicit
`PLAID_ENVIRONMENT` (`sandbox` or `production`), `PLAID_CLIENT_ID`, `PLAID_SECRET`,
`MIDDAY_ENCRYPTION_KEY`, and own `DASHBOARD_URL`/`API_URL`. Production requires
HTTPS. `hostedBanking.enabled` describes configuration, not provider acceptance;
it never enables legacy `banking.enabled`. Keep the feature off until acceptance.

Queued regression targets, each in a separate Bun process:

- `packages/db/src/bank-consent.test.ts`
- `packages/db/src/test/hosted-bank-consent-view.test.ts`
- `packages/db/src/test/hosted-bank-consent-postgres.test.ts` (guarded migrated test DB)
- `apps/api/src/services/plaid-hosted-consent.test.ts`
- `apps/api/src/services/hosted-bank-consent.test.ts`
- `apps/api/src/__tests__/trpc/bank-consents.test.ts`
- `apps/api/src/__tests__/webhooks/plaid-hosted-consent.test.ts`
- `apps/dashboard/src/utils/hosted-bank-consent.test.ts`
- Existing instance-capability and bank-cleanup worker tests.

Provider contracts were checked against the official
[Hosted Link documentation](https://plaid.com/docs/link/hosted-link/) and
[Link API reference](https://plaid.com/docs/api/link/). A completion redirect is
not success evidence; proof uses `link_sessions[].results.item_add_results` from
the exact retained Link token. Plaid recommends its SDKs for ordinary owned web
frontends; this bounded server-first implementation uses Hosted Link to keep
the token exchange out of the browser. A later SDK UI still needs the same
server-side binding and acceptance checks.

## Dashboard entry point

Settings / Bank accounts, the connection modal and initial setup now use the
native owner-only consent router when its separate capability is configured.
The UI never reads provider token/account inputs or treats a completion redirect
as proof. Only a completed server receipt with a connection ID is shown as
verified; that receipt describes the completed attempt, while current sync and
connection status remain in the account list.

Before navigation, a fresh owner capability check and current-session intent
read must return an unexpired URL on the fixed `secure.plaid.com` HTTPS origin.
No cached URL is used as an href. Explicit verification is the only action that
calls provider completion; periodic refresh reads retained SQL state only.
Creation persists a bounded internal command UUID before sending it, so a lost
response or component remount recovers the same command without repeating
provider creation. URLs and credentials are never persisted in browser storage.
An owner-only capability response supplies an opaque UI namespace derived from
the current verified actor, team and Auth session. It is never accepted as
authorization or provider evidence. Pending commands and cached state use that
namespace; a new sign-in remounts the stateful panel instead of repeatedly trying
to recover an inaccessible command from the previous session. The old unknown
provider outcome is not discarded. Queries are isolated by actor/team/session/
component and evicted on unmount; late async responses cannot navigate after
closing the modal or changing team. Every explicit action rechecks the current
namespace before sending its command; the SQL actor/session guards remain the
authority throughout provider IO.

Cancellation remains pending until retained provider cleanup is confirmed.
Unknown create/exchange results require administrator review and never show a
retry-exchange button or a confirmed cancellation. Cleanup status remains visible
after deleting the final bank account. Closed legacy reconnect and account-add
controls are hidden; native reconnection currently requires local removal,
confirmed provider cleanup, and new consent.

Source formatting and diff checks passed. Dashboard types, the pure UI regression
suite, rendered accessibility/interaction checks, and real-provider acceptance
are still pending the coordinator's gates. Keep optional enablement off.
