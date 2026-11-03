# Browser session lifecycle

Every accepted Auth JWT must identify a current auth.sessions row, its own user,
an unexpired not_after and a user who is not banned/deleted. Reads use primary.
Missing/malformed session claims fail closed. Private file keys version3 bind
the same session; old version2 keys are rejected and refreshed by user.me.

Direct authenticated Data API and Storage tables retain all existing tenant/MFA
policies and gain a restrictive current-session policy. Service identities retain
their existing service-role behavior. API keys and app OAuth grants are separate
credentials, not silently described as browser sessions.

Security displays up to100 recent active sessions (no raw tokens). Other/all
revocation removes relevant refresh tokens and sessions in one DB transaction,
restricted to the authenticated account. MFA and owner/team authorization still
apply before mutations. The UI reports success only after the transaction.

Reference: https://supabase.com/docs/guides/auth/sessions — checking session_id
against auth.sessions closes the remaining signed-JWT window after sign-out.
Reference: https://supabase.com/docs/guides/auth/signout — global/local/others.
Real multi-session token/refresh/file/Data API tests are required before release.
Lost-MFA identity recovery and SMTP delivery remain separate operational gates.
