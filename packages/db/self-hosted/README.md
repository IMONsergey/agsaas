# Fresh self-hosted application baseline

This directory is a **new, reconstructed production baseline**, not a recovered
copy of Midday's missing initial database migration. It targets the current
AGSaaS application schema and the pinned Supabase `self-hosted/v0.8.3` platform
(`bc27d2661edd09a5d0b8d76ce33da6d4071a756e`, PostgreSQL `17.6.1.136`).

The 39 SQL files under `packages/db/migrations` remain unchanged historical
incremental migrations. They are not a clean-install recipe and must **not** be
replayed on top of this baseline: their current table/column changes are already
represented here. No test fixture, fake `auth.uid()` or synthetic tracker function
is included in this production baseline.

## Ownership and installation order

1. Initialize the pinned official Supabase platform. It owns `auth`, `storage`,
   platform roles, Auth functions and the `supabase_realtime` publication. Wait
   for Auth's real schema migrations to finish.
2. Provision a dedicated `agsaas_app` login with a separately generated secret:
   `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`, no
   memberships in other roles, and permission to connect to this database. Do
   not put its password into migrations or run the app as `postgres`.
3. Verify the candidate before installing it: one outer transaction containing
   the baseline and the body of `verify.sql`, ending in `ROLLBACK`. The verifier
   creates random fixtures in the actual Auth/application tables and checks
   business calculations and role boundaries. No candidate schema or fixtures
   may remain after this step. The operations helper below composes this safely.
4. Apply the same baseline **atomically** as the privileged bootstrap operator.
   The helper repeats the rollback verification, then runs the baseline and its
   CLI history/checksum records together using
   `psql --single-transaction --set ON_ERROR_STOP=1`. A failed SQL statement must
   leave neither the application schema nor an applied-history marker behind.
5. Run the real Auth/HTTP/browser integration gates below. SQL verification is
   necessary, but it is not a substitute for login, cookies, Realtime delivery,
   SMTP or backups.

The first SQL block refuses to proceed if any application table already exists.
There is no automatic `DROP`, reset, repair or overwrite path. Re-running this
baseline directly is expected to fail. Investigate partial/previous installs
and apply a separately reviewed recovery or upgrade procedure.

### Dedicated installation helper

`scripts/self-hosted-db.mts` runs with Node 24 and accepts only the prepared local
`/opt/agsaas` deployment, `agsaas-stage` Compose project, pinned PostgreSQL image,
healthy database container and exact data bind. It reads the preparer's private
`.env` in memory, requires mode `0600` and a validated owner, and checks the
source checkout is clean. It never selects a remote Docker daemon or an arbitrary
database/container. The operator may need the already-authorized `sudo` access
to Docker; the helper does not escalate or try another connection itself.

```sh
sudo -n /opt/imon-runtime/node/bin/node /opt/agsaas/source/scripts/self-hosted-db.mts \
  --mode provision --runtime /opt/agsaas/runtime/supabase --source /opt/agsaas/source
sudo -n /opt/imon-runtime/node/bin/node /opt/agsaas/source/scripts/self-hosted-db.mts \
  --mode verify --runtime /opt/agsaas/runtime/supabase --source /opt/agsaas/source
sudo -n /opt/imon-runtime/node/bin/node /opt/agsaas/source/scripts/self-hosted-db.mts \
  --mode apply --runtime /opt/agsaas/runtime/supabase --source /opt/agsaas/source
```

Provisioning refuses an existing `agsaas_app` role; it cannot silently rotate
credentials. The raw generated password never enters command arguments or SQL:
Node derives its PostgreSQL SCRAM verifier and sends that only through stdin.
Bootstrap uses the platform's `supabase_admin` operator over the container's local
socket, not the restricted application connection. API/worker credentials remain
the separate non-superuser role.

The helper registers `version`, `name` and SQL-aware `statements` in
`supabase_migrations.schema_migrations` using the exact
[CLI 2.84.6 history format](https://github.com/supabase/cli/blob/v2.84.6/pkg/migration/history.go).
It uses a plain `INSERT`, never an overwrite/UPSERT. An operator-only
`private.agsaas_baseline_installation` row records the baseline SHA-256, source
commit and application time, with a foreign key to that history row. Neither
application nor Data API roles receive access to either record. The helper has
no update/delete path for the checksum; this is an audit marker, **not** a claim
that a PostgreSQL superuser cannot alter it. There is no separate migration
repair step after a successful helper apply.

The success report contains revision/checksum/operation metadata, never secrets.
Errors retain only an exit category and, where PostgreSQL supplies them, a bounded
SQLSTATE and stdin line number. SQL/error text is suppressed. PostgreSQL 17 session
timeouts bound connection/lock/statement/transaction waits. A killed Docker
client is not proof of a rolled-back database operation: inspect actual schema
and history after any ambiguous timeout before attempting a separately reviewed
recovery. The helper never retries mutations automatically.

The migration file name was created by Supabase CLI `2.84.6` using:

```sh
supabase migration new application_baseline --workdir packages/db/self-hosted
```

The generator is offline and does not read credentials or connect to a database:

```sh
bun packages/db/self-hosted/generate.ts --check
bun test packages/db/src/test/self-hosted-bootstrap.test.ts
```

Without `--check`, it prints candidate SQL to stdout for review. Source order is
`before.sql`, generated application DDL/grants, `functions.sql`, `after.sql`.
The checked-in SQL must match these sources. Do not edit the generated SQL by
hand. After the initial baseline is deployed, use new CLI-created, reviewed
incremental migrations in this self-hosted workdir with the privileged operator,
not the application role. Do not overwrite an already-applied baseline or use
`drizzle-kit push` to reconcile a production installation.

## What is installed

| Component | Contract |
| --- | --- |
| Application schema | 49 public tables, 33 enums, current columns/indexes/foreign keys; no application views are required by current callers |
| Extensions | `vector`, `pg_trgm`, `pgcrypto`, in `extensions`; an unexpected existing namespace fails rather than being moved automatically |
| Inbox search | Real immutable product-name extraction and weighted English FTS; nullable or non-array legacy metadata is safe |
| Random defaults | Independent lowercase email-safe inbox aliases; 24-character cryptographic URL-safe invitation tokens |
| Tracker | Sum stored seconds, ignore NULL running duration, hourly project rate × seconds / 3600, distinct assigned profiles scoped to project team/current membership |
| Banking | Distinct enabled-account currencies and real enabled-account balances, including manual accounts, scoped to the requested team |
| Search | Six existing UI entity types (`transaction`, `invoice`, `customer`, `vault`, `inbox`, `tracker_project`), lexical prefix ranking, per-type/overall limits, typed date/amount/status/currency/due-date filters |
| Related documents | Actual `pg_trgm` title similarity; source/candidates must belong to the requested team |
| Document FTS | INSERT/UPDATE trigger populating `fts_simple`, `fts_english`, `fts_language`; built-in language configuration allowlist, safe fallback |
| Auth bridge | Synchronous profile insert, authoritative email synchronization, real `public.users.id → auth.users.id ON DELETE CASCADE` |
| Realtime | Publication membership for `inbox`, `documents`, `transactions`, `customers`, `activities`, `insights`; explicit read authorization |

`global_semantic_search` is a historical name for **filtered full-text search**.
The actual caller supplies 15 scalar/filter arguments, not an embedding vector.
No fake vector or external model call is involved in this SQL routine. The
optional LLM filter-generation step in the API still requires its real provider.
Category/tag embedding fields retain the real `vector(768)` type; their distance
queries already live in TypeScript.

Search dates are calendar dates with UTC fallbacks for timestamps, endpoints are
inclusive, and amounts remain signed. `get_project_total_amount` intentionally
matches the existing per-project entry query, which uses the current project
rate regardless of `billable`; billable-only earnings are a separate report.
Tracker duration returns `double precision` so node-postgres exposes a number,
matching the API contract, rather than an unparsed `int8` string.

The reconstructed search routines prioritize correct contracts and bounded
results. Language-specific tokenization can scan the selected team's candidate
rows; large tenants still need measured query plans and workload-specific index
tuning. A result limit is not a claim that candidate scanning is bounded.

## Authorization boundary

All 49 application tables have RLS enabled. The backend login has no global RLS
bypass: each application table has an explicit `agsaas_backend` policy allowing
that trusted role to perform granted CRUD. It does not own the tables or receive
schema `CREATE`, Auth/Storage table permissions, `TRUNCATE` or role-management
privileges. Its search path is `public, extensions` for existing unqualified
trigram calls. Backend tenant isolation still depends on the API's fresh
authentication/membership checks and tenant-filtered queries; this is not a
claim that a stolen backend credential is isolated to one team.

`anon` has no application-table privileges. `authenticated` can read only:

- Its own `users` profile and teams with a current `users_on_team` membership.
- Team-scoped `inbox`, `documents`, `transactions`, `customers`, `insights`.
- `activities` addressed to its own Auth subject **and** a current team.
- Bank-connection `id`/`team_id`; only `expires_at` and `reference_id` may be
  updated for the existing GoCardless reconnect callback. The helper now
  requests only the returned `id`, not integration credentials.

Other client writes go through the existing API. There are no browser grants
for membership changes, API/OAuth keys, inbox-account tokens or bank access
tokens. `service_role` receives application CRUD and the same explicitly listed
business-function execution grants; its platform-level powers remain managed
by Supabase.

Browser membership is checked using the real signed request's `auth.uid()` and
the current membership table. Editable metadata or a `team_id` claim cannot
grant membership. The private membership helper has a locked search path and
no caller-supplied identity parameter. Other business routines are security
invoker, execute only for the backend/service roles, and are not anonymous or
authenticated PostgREST RPCs.

The two Auth trigger functions are narrowly scoped security definers, have an
empty search path, and have direct execution revoked. Profile names/avatar URLs
may use display metadata; email comes only from the Auth row. Team selection,
ownership and memberships never come from metadata. The existing API creates
the first team, owner membership and system categories in its own transaction;
the trigger must not duplicate that work. No marketing/signup webhook is needed
for the core profile/team flow.

## Deliberate differences from the legacy Drizzle declaration

`schema.ts` now correctly declares `pgSchema("auth").table("users", ...)` for
the foreign-key mapping. That declaration is excluded from generated application
DDL; Supabase's managed columns, indexes and policies are never recreated.
All runtime DB clients use `runtimeSchema`, which excludes the managed Auth
table/relation to avoid the ORM's bare-name type collision between `auth.users`
and `public.users`. Membership/tracker queries continue to use the full public
profile and its existing application relations.

The fresh generator also corrects four incomplete imported declarations without
rewriting the historical bare-Postgres test harness:

1. Replace the self-referencing profile foreign key with the real Auth FK.
2. Execute `generate_inbox(10)` instead of storing its name as a string literal.
3. Execute `nanoid(24)` instead of using one constant invitation code.
4. Make the generated document FTS expression null-safe for pending documents.

It replaces incomplete imported policies (several omit predicates) with the
explicit policies described above. Current Drizzle inserts send SQL `DEFAULT`
for omitted fields; a regression test verifies they do not send the old literal
function names. Do not use the legacy schema-push configuration on this DB:
doing so could undo these production-only corrections and authorization rules.

## Verification gates and limitations

The offline Bun suite checks generation, ownership, guards, grants, function
ordering, Auth FK and current runtime insert SQL without a database. The SQL
verifier must additionally prove on the actual pinned Supabase/PostgreSQL:

- Auth profile insert, display-metadata handling, email sync and deletion FK.
- Two team/invitation inserts with real random defaults; app role CRUD without
  superuser, global RLS bypass or Auth credential access.
- Tracker durations, fractional-hour amounts, assignee deduplication and
  cross-team filtering; banking data, generated/triggered FTS and title similarity.
- Six-type global search, prefix matching, caps, data shape and scalar filters.
- Anonymous denial, authenticated self/team reads, membership revocation,
  restricted bank reconnect updates and private-token denial.
- Realtime publication membership (not actual websocket delivery).

Still required before calling the product fully operational:

- Real email OTP/signup and OAuth callback/cookie/session round-trips through the
  public TLS origin and internal Supabase transport, including refresh/logout.
- First-team creation, user profile completion, invitations and a second-team
  scenario through the real API/dashboard, not just direct SQL inserts.
- Realtime events delivered to the authorized client and not to another team.
- Separate platform Storage bucket/policy/provisioning work and its integration
  tests; this application baseline does not modify `storage` objects.
- Backup/restore, SMTP delivery, jobs and each enabled optional provider.

No frontend layout, styling or successful application response shape is changed
by this baseline. Test results describe only the checks actually run; a schema
that generates successfully is not by itself a deployed or validated product.
