# Bank provider cleanup after local deletion

Local connection, team and account deletion creates one encrypted cleanup intent
per removed bank connection in the same PostgreSQL transaction. The table has no
foreign key to the removed team, connection or user. Existing membership/last
owner checks and the retryable Auth account-deletion preparation remain intact.
Single-connection deletion rechecks the actual actor under the user membership
and team locks before locking or deleting the connection.
A rejected or rolled-back deletion creates no recoverable cleanup.

The `reconcile-bank-connections` scheduler on the own `teams` queue runs every
minute, including preview. It reads at most ten due IDs and invokes the provider
outside SQL locks. No connection token or provider reference is put into a new
Redis job, cleanup/deletion API response, status projection or application log. Requests do not
need Redis to commit: the next scan recovers them after Redis outage or restart.
There is no automatic backfill of historical deletions or legacy queue payloads.

## Configuration and outcomes

The API and worker must share the existing `MIDDAY_ENCRYPTION_KEY`. Creation of
an intent fails closed if secure encryption is unavailable; the local deletion
then rolls back. A worker with a missing/wrong decryption key or missing provider
configuration leaves the intent pending without consuming a dispatch attempt.

Provider configuration required on the worker:

| Provider | Keys |
| --- | --- |
| Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, matching `PLAID_ENVIRONMENT` |
| GoCardless | `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` |
| Teller | `TELLER_CERT_BASE64`, `TELLER_KEY_BASE64` |
| Enable Banking | `ENABLEBANKING_APPLICATION_ID`, `ENABLE_BANKING_KEY_CONTENT`, `ENABLEBANKING_REDIRECT_URL` |

The encrypted target is immutable. Do not rotate the encryption key without
retaining the ability to decrypt unresolved intents. Do not change a provider's
environment or application account while it has unresolved cleanup requests.

* `pending`: no dispatch yet, configuration unavailable, or a confirmed 429
  rejection. Configuration and 429 backoff are five minutes. The provider retry
  budget is twelve dispatch attempts.
* `processing`: one SQL fence permits a provider request. The lease is two
  minutes; provider calls have bounded timeouts.
* `completed`: the provider acknowledged removal, or Plaid returned its documented
  `ITEM_NOT_FOUND` result. Ciphertext is erased in the same SQL update recording
  completion. This confirms the provider connection cleanup, not deletion of the
  user's underlying bank account or every consent the bank may maintain.
* `reconciliation`: rejected/ambiguous response, crashed or timed-out attempt,
  invalid source identity, clock anomaly or exhausted retry budget. The worker
  never automatically repeats this request. A late definitive success with the
  original fence can still settle the row and erase ciphertext.

Only explicit rate-limit rejection is automatically retried. In particular,
Plaid `INVALID_ACCESS_TOKEN`, generic 404, 5xx and missing HTTP responses are not
interpreted as successful revocation. Teller DELETE checks HTTP success instead
of treating every resolved `fetch()` as success.

Legacy `delete-team` jobs with connection payloads fail closed with an operator
reconciliation message. Inspect and resolve them manually; do not resubmit their
credentials to the new queue. Empty legacy cleanup jobs have no provider work.

## Visibility and retention

The banking page displays pending and reconciliation states for the current
team. `bankConnections.cleanupStatus` is scoped to that team and returns only
IDs, provider, status, attempt count, schedule and sanitized reason codes.
Deleted teams intentionally cannot be re-entered to inspect cleanup. Authorized
operators use the following metadata-only query against their own installation:

```sql
SELECT id, team_id, connection_id, provider, status, attempts,
       next_attempt_at, last_error, created_at, updated_at, completed_at
FROM public.bank_connection_cleanups
WHERE status <> 'completed'
ORDER BY (status = 'reconciliation') DESC, created_at;
```

Alert on every reconciliation row and on pending rows older than 24 hours.
Check this list after deletions, deployments, queue outages and key rotation.
No automated alert destination or provider credentials are configured by this
change; operators must connect these checks to their own monitoring.

Confirmed cleanup erases credential ciphertext immediately. Unresolved encrypted
credentials remain only to finish or reconcile the requested revocation; they
are not copied back into a live connection. They are not silently expired,
because that would lose the only remaining ability to revoke access. The
operator must review unresolved rows and determine whether the provider has
removed the exact connection, or whether a safe retry is supported. After a
verified provider-side removal, an authorized operator may record completion and
set `encrypted_payload = NULL`, `completed_at = clock_timestamp()`, and clear the
fence in one transaction. Do not mark success based only on an unavailable API.

If a retry is explicitly approved after checking the provider's semantics and
current state, reset only that row from reconciliation to pending, clear its
fence and lease, set a due `next_attempt_at`, and document the decision outside
the credential payload. A stale pre-existing fence must not survive a reset.
Do not reset an active `processing` row. This is an operator action, not an
automatic application endpoint.

Completed metadata is retained for troubleshooting without credential material.
An installation may remove completed rows older than its chosen audit retention
period; unresolved rows must first be reviewed. Backups can contain historical
ciphertext and must follow the installation's encryption-key and backup
retention policy. This feature does not erase pre-existing provider tokens from
historical Redis jobs or database backups.

## Provider references

* Plaid removal: https://plaid.com/docs/api/items/#itemremove
* Plaid `ITEM_NOT_FOUND`: https://plaid.com/docs/errors/item/#item_not_found
* Plaid invalid-token ambiguity: https://plaid.com/docs/errors/invalid-input/#invalid_access_token
* Teller DELETE accounts and 204 response: https://teller.io/docs/api/accounts/
* Enable Banking session deletion: https://enablebanking.com/docs/api/reference/#delete-session

No live provider requests were used to validate this change. Tests cover real
PostgreSQL transactions/ACL/fences and fake HTTP responses at the transport
boundary; actual provider configuration and an authorized lifecycle smoke test
remain deployment prerequisites before enabling bank integrations.
