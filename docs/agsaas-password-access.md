# Password access and recovery

This installation supports an explicitly enabled password sign-in method,
authenticated password changes, and an optional Supabase Auth email recovery
flow. These features do not enable public registration, create accounts, confirm
users automatically, or substitute an application session for an Auth session.

## Configuration and publication

| Setting | Requirement |
| --- | --- |
| `AUTH_ENABLED_PROVIDERS` | Include `password` to show password sign-in and account password changes. This is a server-only allowlist. |
| `AUTH_PASSWORD_RECOVERY_ENABLED` | Defaults to disabled. Only the literal `true`, together with the password provider, enables recovery UI, request action, callback and final reset action. Enable it after configuring and testing real Auth SMTP delivery. |
| `NEXT_PUBLIC_URL` | Canonical own dashboard HTTP(S) origin, HTTPS for public access. Recovery never accepts a caller-supplied redirect origin. |
| Supabase `SITE_URL` | Own dashboard URL. |
| Supabase `ADDITIONAL_REDIRECT_URLS` | Include the exact own `${NEXT_PUBLIC_URL}/api/auth/password-recovery` callback in the deployed GoTrue allowlist. Retain other callbacks needed by enabled login methods. |
| Auth SMTP settings | Configure the installation's actual sender and SMTP transport in the official Supabase environment. Product email via Resend is a separate channel. A private Mailpit capture does not establish delivery to users' mailboxes. |
| `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` | The self-hosted platform overlay sets this to `true`, enforcing the current-password check at GoTrue for direct SDK calls as well as this UI. Recovery sessions receive GoTrue's documented recovery exception. |

The request page reads configuration at request time. If recovery is disabled,
login and `/forgot-password` clearly say reset emails are unavailable and direct
the user to the workspace owner; no enabled email form or outbound Auth request
is offered. Password changes in account security remain available when password
sign-in is enabled, independently of the recovery email flag.

The separate `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION` option
requires an email/phone reauthentication nonce for older sessions. This package
does not enable that option and does not implement its nonce-entry flow. Do not
confuse it with the current-password option above.

## Recovery flow

1. `/forgot-password` submits an email to the server action. The action uses the
   ordinary SSR Supabase client and `resetPasswordForEmail`, with a fixed own
   callback URL. Supabase generates a PKCE verifier in the requesting browser's
   cookie storage. No administrator Auth API is involved.
2. The response is the same for an unknown account, provider refusal and
   transport failure. It says to check email if the account is eligible; it does
   not disclose account existence or claim that a mailbox delivery succeeded.
   Neither email addresses nor Auth diagnostics are logged by these actions.
3. The email link must be opened in the **same browser** that requested it. The
   callback exchanges its code with the PKCE verifier and only accepts the
   session returned by that successful exchange. An ambient prior login,
   `type=recovery` query parameter or editable SDK redirect-type suffix is not
   recovery authorization.
4. Supabase-verified claims must identify the same user and a real authenticated
   session, with a top-level `amr` recovery method no older than 15 minutes. The
   time limit begins with the Auth recovery authentication; the email link's own
   expiry remains governed separately by GoTrue. Callback redirects use the
   installation's own origin and send `Cache-Control: private, no-store` plus
   `Referrer-Policy: no-referrer`.
5. Users with enrolled MFA complete the ordinary MFA challenge before the reset
   form. Both the form and final reset action verify the recovery claims again
   and call the protected `user.me` API against primary state. That API enforces
   authoritative enrolled-factor requirements and rejects deleted/deleting
   profiles. An MFA-off account is not required to invent an AAL2 session.
6. The reset uses `auth.updateUser({ password })` on this original session.
   On success, the UI returns to ordinary password sign-in and the action tries
   to end the recovery session locally. A logout transport failure does not
   misreport an already completed password write as a failed reset.

## Authenticated password change

Account → Security requests the current password, a new password and its
confirmation. The server validates a 12–128 character new password; GoTrue may
apply additional configured password rules. The final action checks current
primary profile access and MFA through the same protected API.

The current password is verified by a disposable **public-key** Supabase client
using standard `signInWithPassword`. This client has no cookie adapter, persistent
storage, automatic refresh or URL session detection. Its AAL1 session stays in
that instance's memory; it is never installed into the user's original browser
or server session. Verification requests have a five-second timeout and use the
configured private transport when present.

Only a matching verified user permits the original SSR client to call
`updateUser({ password, current_password })`. The original MFA-authenticated
session is retained. The disposable client is cleaned up with `scope: "local"`
only; no global sign-out is performed by that verifier. Errors remain generic,
and the actions use the safe-action client without development input logging.

The pinned GoTrue password-update implementation revokes other sessions and
clears recovery/one-time tokens while preserving the session performing the
update. This is provider behavior, not a claim that every previously issued
access JWT becomes instantly invalid. The application does not promise instant
JWT revocation or bypass the provider's configured session rules.

## Validation and operational evidence

Run the isolated local suites from the repository root:

```sh
bun test apps/dashboard/src/utils/password-policy.test.ts
bun test apps/dashboard/src/utils/password-flows.test.ts
```

The fixtures inherit no deployed secrets and deny real network access. They
exercise actual actions, callbacks, public page capability rendering and proxy
MFA routing with isolated Auth/API responses. The real installed Supabase SDK is
also exercised against an in-process fake HTTP transport: PKCE challenge/verifier
continuity across SSR requests, current-password verification without cookie
mutation, use of the original AAL2 token for update, and local-only verifier
logout. Those tests do not send emails or establish live provider delivery.

Before enabling email recovery for users, a controlled operational check must
confirm an email reaches an owned mailbox, the same-browser PKCE callback works,
an enrolled account completes MFA, the new password works and the old password
is rejected. Do not publish message bodies, recovery codes, tokens or passwords
as evidence. When SMTP is not configured, keep the recovery flag disabled and
report that limitation explicitly.

Primary implementation references:

- [Supabase password-based authentication](https://supabase.com/docs/guides/auth/passwords)
- [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Locked Auth client v2.118.0](https://github.com/supabase/supabase-js/blob/v2.118.0/packages/core/auth-js/src/GoTrueClient.ts)
- [Pinned GoTrue v2.197.0 password update policy](https://github.com/supabase/auth/blob/v2.197.0/internal/api/user.go)
- [Pinned GoTrue v2.197.0 session/token cleanup](https://github.com/supabase/auth/blob/v2.197.0/internal/models/user.go)
