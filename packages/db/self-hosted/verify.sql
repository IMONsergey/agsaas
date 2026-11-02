-- Run only on the new private self-hosted installation after the baseline:
-- psql --set ON_ERROR_STOP=1 --file packages/db/self-hosted/verify.sql
-- Real managed Auth tables/functions are required. No mocks, TRUNCATE, SMTP,
-- providers or network operations. Every fixture and mutation is rolled back.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, extensions;

CREATE FUNCTION pg_temp.assert_true(condition boolean, description text)
RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Bootstrap contract failed: %', description;
  END IF;
END;
$assert$;

CREATE TEMP TABLE agsaas_verify_ids (
  user_a uuid DEFAULT gen_random_uuid(), user_b uuid DEFAULT gen_random_uuid(),
  team_a uuid DEFAULT gen_random_uuid(), team_b uuid DEFAULT gen_random_uuid(),
  project_a uuid DEFAULT gen_random_uuid(), project_b uuid DEFAULT gen_random_uuid(),
  bank_a uuid DEFAULT gen_random_uuid(), bank_b uuid DEFAULT gen_random_uuid(),
  account_a uuid DEFAULT gen_random_uuid(), account_b uuid DEFAULT gen_random_uuid(),
  document_a uuid DEFAULT gen_random_uuid(), document_similar uuid DEFAULT gen_random_uuid(),
  document_b uuid DEFAULT gen_random_uuid(), document_pending uuid DEFAULT gen_random_uuid(),
  customer_a uuid DEFAULT gen_random_uuid(), customer_b uuid DEFAULT gen_random_uuid(),
  invoice_a uuid DEFAULT gen_random_uuid(), invoice_b uuid DEFAULT gen_random_uuid()
) ON COMMIT DROP;
INSERT INTO agsaas_verify_ids DEFAULT VALUES;
GRANT SELECT ON agsaas_verify_ids TO agsaas_app, authenticated, anon;

-- Authentic Auth rows exercise the real trigger and profile foreign key.
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT user_a, 'bootstrap+' || user_a || '@example.invalid',
  jsonb_build_object('full_name', 'Bootstrap A', 'avatar_url', 'https://example.invalid/a.png',
    'team_id', team_b, 'role', 'owner', 'email', 'spoofed@example.invalid')
FROM agsaas_verify_ids;
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT user_b, 'bootstrap+' || user_b || '@example.invalid',
  jsonb_build_object('name', 'Bootstrap B', 'picture', 'https://example.invalid/b.png')
FROM agsaas_verify_ids;

SELECT pg_temp.assert_true((
  SELECT count(*) = 2 FROM public.users profile, agsaas_verify_ids ids
  WHERE profile.id IN (ids.user_a, ids.user_b) AND profile.team_id IS NULL
    AND profile.email = 'bootstrap+' || profile.id || '@example.invalid'
), 'Auth insert synchronously creates profiles without metadata team/email authority');
SELECT pg_temp.assert_true((
  SELECT full_name = 'Bootstrap B' AND avatar_url = 'https://example.invalid/b.png'
  FROM public.users, agsaas_verify_ids WHERE id = user_b
), 'OAuth display-only name/picture aliases are supported');
UPDATE public.users SET full_name = 'Manual profile name', locale = 'ru'
WHERE id = (SELECT user_a FROM agsaas_verify_ids);
UPDATE auth.users SET email = 'updated+' || id || '@example.invalid',
  raw_user_meta_data = jsonb_build_object('full_name', 'Do not overwrite')
WHERE id = (SELECT user_a FROM agsaas_verify_ids);
SELECT pg_temp.assert_true((
  SELECT full_name = 'Manual profile name' AND locale = 'ru'
    AND email = 'updated+' || id || '@example.invalid'
  FROM public.users, agsaas_verify_ids WHERE id = user_a
), 'Auth email sync preserves application profile edits');

SET LOCAL ROLE agsaas_app;
SELECT pg_temp.assert_true((
  SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit
  FROM pg_catalog.pg_roles WHERE rolname = current_user
), 'runtime role has no global RLS bypass or inherited privileges');
SELECT pg_temp.assert_true(NOT has_schema_privilege(current_user, 'public', 'CREATE'),
  'runtime role cannot create arbitrary public objects');
-- Resolving the text name 'auth.users' itself requires schema USAGE. Inspect
-- its catalog OID instead: the backend deliberately has no Auth schema grant.
SELECT pg_temp.assert_true((
  SELECT NOT has_table_privilege(current_user, relation.oid, 'SELECT')
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'auth' AND relation.relname = 'users'
),
  'runtime role cannot read Auth credentials');
DO $foreign_key$
BEGIN
  BEGIN
    INSERT INTO public.users (id) VALUES (gen_random_uuid());
    RAISE EXCEPTION 'A profile without an Auth identity was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END;
$foreign_key$;

INSERT INTO public.teams (id, name, base_currency)
SELECT team_a, 'Bootstrap A', 'USD' FROM agsaas_verify_ids
UNION ALL SELECT team_b, 'Bootstrap B', 'EUR' FROM agsaas_verify_ids;
SELECT pg_temp.assert_true((
  SELECT count(DISTINCT inbox_id) = 2 AND bool_and(inbox_id ~ '^[a-z0-9]{10}$')
  FROM public.teams, agsaas_verify_ids WHERE id IN (team_a, team_b)
), 'two default-created teams receive distinct email-safe inbox aliases');
INSERT INTO public.users_on_team (user_id, team_id, role)
SELECT user_a, team_a, 'owner'::public."teamRoles" FROM agsaas_verify_ids
UNION ALL SELECT user_b, team_b, 'owner'::public."teamRoles" FROM agsaas_verify_ids;
UPDATE public.users SET team_id = ids.team_a FROM agsaas_verify_ids ids WHERE id = ids.user_a;
UPDATE public.users SET team_id = ids.team_b FROM agsaas_verify_ids ids WHERE id = ids.user_b;

INSERT INTO public.user_invites (team_id, email, role, invited_by)
SELECT team_a, 'invite-a@example.invalid', 'member'::public."teamRoles", user_a FROM agsaas_verify_ids
UNION ALL SELECT team_a, 'invite-b@example.invalid', 'member'::public."teamRoles", user_a FROM agsaas_verify_ids;
SELECT pg_temp.assert_true((
  SELECT count(DISTINCT code) = 2 AND bool_and(code ~ '^[A-Za-z0-9_-]{24}$')
  FROM public.user_invites, agsaas_verify_ids WHERE team_id = team_a
), 'two default invitations receive independent cryptographic URL-safe codes');

INSERT INTO public.tracker_projects (id, team_id, name, rate, currency, billable)
SELECT project_a, team_a, 'Atlas project', 120, 'USD', false FROM agsaas_verify_ids
UNION ALL SELECT project_b, team_b, 'Atlas project', 999, 'EUR', true FROM agsaas_verify_ids;
INSERT INTO public.tracker_entries (project_id, team_id, assigned_id, duration)
SELECT project_a, team_a, user_a, 3600 FROM agsaas_verify_ids
UNION ALL SELECT project_a, team_a, user_a, 1800 FROM agsaas_verify_ids
UNION ALL SELECT project_a, team_a, user_a, NULL FROM agsaas_verify_ids
-- Simulate a malformed historical FK; helpers must not cross the team boundary.
UNION ALL SELECT project_a, team_b, user_b, 7200 FROM agsaas_verify_ids;
SELECT pg_temp.assert_true((
  SELECT public.total_duration(project) = 5400
    AND public.get_project_total_amount(project) = 180
    AND public.get_assigned_users_for_project(project) = jsonb_build_array(jsonb_build_object(
      'user_id', ids.user_a, 'full_name', 'Manual profile name', 'avatar_url', 'https://example.invalid/a.png'))
  FROM public.tracker_projects project, agsaas_verify_ids ids WHERE project.id = ids.project_a
), 'tracker seconds, fractional-hour amount, running/null timer and deduplicated assignees');
SELECT pg_temp.assert_true((
  SELECT public.total_duration(project) = 0 AND public.get_project_total_amount(project) = 0
    AND public.get_assigned_users_for_project(project) = '[]'::jsonb
  FROM public.tracker_projects project, agsaas_verify_ids ids WHERE project.id = ids.project_b
), 'empty project calculations are real zero/empty results');

INSERT INTO public.bank_connections (id, team_id, institution_id, name, provider, access_token)
SELECT bank_a, team_a, 'bootstrap-a', 'Bank A', 'gocardless'::public.bank_providers, 'not-a-live-token' FROM agsaas_verify_ids
UNION ALL SELECT bank_b, team_b, 'bootstrap-b', 'Bank B', 'gocardless'::public.bank_providers, 'not-a-live-token' FROM agsaas_verify_ids;
INSERT INTO public.bank_accounts (id, team_id, created_by, bank_connection_id, account_id, name, currency, balance)
SELECT account_a, team_a, user_a, bank_a, account_a::text, 'Account A', 'USD', 125.5 FROM agsaas_verify_ids
UNION ALL SELECT account_b, team_b, user_b, bank_b, account_b::text, 'Account B', 'EUR', 900 FROM agsaas_verify_ids;
INSERT INTO public.bank_accounts (team_id, created_by, account_id, name, currency, balance, enabled)
SELECT team_a, user_a, gen_random_uuid()::text, 'Manual EUR', 'EUR', 100.5, true FROM agsaas_verify_ids
UNION ALL SELECT team_a, user_a, gen_random_uuid()::text, 'Disabled USD', 'USD', 9999, false FROM agsaas_verify_ids;
SELECT pg_temp.assert_true((
  SELECT array_agg(currency ORDER BY currency) = ARRAY['EUR', 'USD']
  FROM public.get_bank_account_currencies((SELECT team_a FROM agsaas_verify_ids))
), 'bank currencies are distinct, sorted and tenant scoped');
SELECT pg_temp.assert_true((
  SELECT count(*) = 2 AND sum(balance) = 226
  FROM public.get_team_bank_accounts_balances((SELECT team_a FROM agsaas_verify_ids))
), 'balances include enabled manual accounts and exclude disabled/other-team accounts');

INSERT INTO public.customers (id, team_id, name, email)
SELECT customer_a, team_a, 'Atlas customer', 'atlas-a@example.invalid' FROM agsaas_verify_ids
UNION ALL SELECT customer_b, team_b, 'Atlas customer', 'atlas-b@example.invalid' FROM agsaas_verify_ids;
INSERT INTO public.invoices (id, team_id, customer_id, invoice_number, customer_name, amount, currency, status, issue_date, due_date)
SELECT invoice_a, team_a, customer_a, 'Atlas INV-001', 'Atlas customer', 180, 'USD', 'paid'::public.invoice_status,
  '2026-06-01'::timestamptz, '2026-06-30'::timestamptz FROM agsaas_verify_ids
UNION ALL SELECT invoice_b, team_b, customer_b, 'Atlas INV-001', 'Atlas customer', 999, 'EUR', 'paid'::public.invoice_status,
  '2026-06-01'::timestamptz, '2026-06-30'::timestamptz FROM agsaas_verify_ids;
INSERT INTO public.transactions (team_id, bank_account_id, date, name, method, amount, currency, internal_id)
SELECT team_a, account_a, '2026-06-05'::date, 'Atlas transaction', 'card_purchase'::public."transactionMethods", -42.25, 'USD', gen_random_uuid()::text FROM agsaas_verify_ids
UNION ALL SELECT team_b, account_b, '2026-06-05'::date, 'Atlas transaction', 'card_purchase'::public."transactionMethods", -99, 'EUR', gen_random_uuid()::text FROM agsaas_verify_ids;
INSERT INTO public.inbox (team_id, display_name, date, amount, currency, meta)
SELECT team_a, 'Atlas receipt', '2026-06-05'::date, 42.25, 'USD', '{"products":[{"name":"Printer"},"Paper"]}'::json FROM agsaas_verify_ids
UNION ALL SELECT team_b, 'Atlas receipt', '2026-06-05'::date, 99, 'EUR', NULL::json FROM agsaas_verify_ids;
SELECT pg_temp.assert_true(public.extract_product_names('[{"name":"Printer"},{"description":"Paper"},"Ink",null]'::json) = 'Printer Paper Ink ',
  'product FTS helper handles legacy object/string products without placeholders');
SELECT pg_temp.assert_true(public.extract_product_names('{"not":"an array"}'::json) = ''
  AND public.generate_inbox_fts(NULL, NULL) = ''::tsvector,
  'missing/non-array inbox metadata remains safe and immutable');
SELECT pg_temp.assert_true((
  SELECT fts @@ to_tsquery('english', 'print:* & paper:*')
  FROM public.inbox, agsaas_verify_ids WHERE team_id = team_a
), 'stored inbox FTS contains actual extracted products');

INSERT INTO public.documents (id, team_id, name, title, body, summary, language, date)
SELECT document_a, team_a, 'atlas-contract.pdf', 'Atlas annual contract', 'Nebulous provisions', 'Annual contract', 'en', '2026-06-02'::date FROM agsaas_verify_ids
UNION ALL SELECT document_similar, team_a, 'atlas-copy.pdf', 'Atlas annual contract', 'A copy', NULL, 'english', '2026-06-02'::date FROM agsaas_verify_ids
UNION ALL SELECT document_b, team_b, 'atlas-contract.pdf', 'Atlas annual contract', 'Other tenant', NULL, 'en', '2026-06-02'::date FROM agsaas_verify_ids;
INSERT INTO public.documents (id, team_id, name)
SELECT document_pending, team_a, 'pending.pdf' FROM agsaas_verify_ids;
SELECT pg_temp.assert_true((
  SELECT fts IS NOT NULL AND fts_english @@ to_tsquery('english', 'pend:*')
  FROM public.documents, agsaas_verify_ids WHERE id = document_pending
), 'normal pending documents insert successfully without title/body');
SELECT pg_temp.assert_true((
  SELECT fts_english @@ to_tsquery('english', 'nebul:*') AND fts_simple IS NOT NULL AND fts_language IS NOT NULL
  FROM public.documents, agsaas_verify_ids WHERE id = document_a
), 'document search fields are populated synchronously');
UPDATE public.documents SET body = 'Renewed provisions', language = 'unknown-language'
WHERE id = (SELECT document_a FROM agsaas_verify_ids);
SELECT pg_temp.assert_true((
  SELECT fts_english @@ to_tsquery('english', 'renew:*') AND NOT (fts_english @@ to_tsquery('english', 'nebul:*'))
  FROM public.documents, agsaas_verify_ids WHERE id = document_a
), 'document FTS updates and unsupported language safely falls back');
SELECT pg_temp.assert_true((
  SELECT count(*) = 1 AND bool_and(id = (SELECT document_similar FROM agsaas_verify_ids))
  FROM public.match_similar_documents_by_title((SELECT document_a FROM agsaas_verify_ids), (SELECT team_a FROM agsaas_verify_ids), 0.9, 10)
), 'title similarity excludes source and foreign-tenant matches');
SELECT pg_temp.assert_true((
  SELECT count(*) = 0 FROM public.match_similar_documents_by_title(
    (SELECT document_b FROM agsaas_verify_ids), (SELECT team_a FROM agsaas_verify_ids), 0, 10)
), 'foreign-tenant source document cannot seed a similarity query');

SELECT pg_temp.assert_true((
  SELECT count(*) = 6 AND count(DISTINCT type) = 6
    AND bool_and(data ->> 'team_id' = (SELECT team_a::text FROM agsaas_verify_ids))
    AND bool_and(data ? 'id') AND bool_and(relevance > 0)
  FROM public.global_search('Atl', (SELECT team_a FROM agsaas_verify_ids), 'en', 100, 1, 0)
), 'global prefix search preserves six UI entity types, row shape, tenant isolation and per-type limit');
SELECT pg_temp.assert_true((
  SELECT count(*) = 2 FROM public.global_search('Atlas', (SELECT team_a FROM agsaas_verify_ids), 'english', 2, 100, 0)
), 'global total limit is enforced');
SELECT pg_temp.assert_true((
  SELECT count(*) > 0 FROM public.global_search(NULL, (SELECT team_a FROM agsaas_verify_ids), NULL, NULL, NULL, NULL)
), 'empty global search returns bounded recent records');
SELECT pg_temp.assert_true((
  SELECT count(*) = 0 FROM public.global_search('! & ()', (SELECT team_a FROM agsaas_verify_ids))
), 'punctuation is not interpreted as unrestricted search or tsquery code');
SELECT pg_temp.assert_true((
  SELECT count(*) = 1 AND bool_and(id = (SELECT invoice_a FROM agsaas_verify_ids))
  FROM public.global_semantic_search((SELECT team_a FROM agsaas_verify_ids), 'Atlas',
    '2026-06-01', '2026-06-30', ARRAY['invoices'], 180, 100, 200, 'paid', 'usd', 'en',
    '2026-06-30', '2026-06-30', 20, 5)
), 'filtered search applies dates, invoice due dates, signed amounts, status, currency and types');
SELECT pg_temp.assert_true((
  SELECT count(*) = 1 AND bool_and(data ->> 'amount' = '-42.25')
  FROM public.global_semantic_search((SELECT team_a FROM agsaas_verify_ids), NULL,
    '2026-06-05', '2026-06-05', ARRAY['transactions'], -42.25, NULL, NULL, NULL, 'USD')
), 'transaction filtering retains signed amounts and inclusive date endpoints');
SELECT pg_temp.assert_true((
  SELECT count(*) = 0 FROM public.global_semantic_search((SELECT team_a FROM agsaas_verify_ids), NULL,
    NULL, NULL, ARRAY['invoices'], NULL, NULL, NULL, 'unpaid')
), 'filter mismatch returns no invented results');

INSERT INTO public.activities (team_id, user_id, type, source, metadata)
SELECT team_a, user_a, 'customer_created'::public.activity_type, 'user'::public.activity_source, '{}'::jsonb FROM agsaas_verify_ids
UNION ALL SELECT team_a, user_b, 'customer_created'::public.activity_type, 'user'::public.activity_source, '{}'::jsonb FROM agsaas_verify_ids
UNION ALL SELECT team_b, user_a, 'customer_created'::public.activity_type, 'user'::public.activity_source, '{}'::jsonb FROM agsaas_verify_ids;
RESET ROLE;

SELECT pg_temp.assert_true((
  SELECT count(*) = 6 FROM pg_catalog.pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    AND tablename IN ('inbox', 'documents', 'transactions', 'customers', 'activities', 'insights')
), 'all six existing Realtime subscriptions have published tables');

-- A genuine signed JWT is exercised by the HTTP smoke separately; this is the
-- exact claims GUC PostgREST supplies to the actual managed auth.uid() helper.
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', user_a, 'role', 'authenticated', 'team_id', team_b)::text, true)
FROM agsaas_verify_ids;
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true((
  SELECT array_agg(team) = ARRAY[(SELECT team_a FROM agsaas_verify_ids)]
  FROM private.get_teams_for_authenticated_user() team
), 'membership ignores forged/stale team claims and uses the actual Auth subject');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.users WHERE id IN (SELECT user_a FROM agsaas_verify_ids UNION ALL SELECT user_b FROM agsaas_verify_ids)),
  'authenticated profile read is self-only');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.teams WHERE id IN (SELECT team_a FROM agsaas_verify_ids UNION ALL SELECT team_b FROM agsaas_verify_ids)),
  'authenticated teams are membership scoped');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.customers WHERE id IN (SELECT customer_a FROM agsaas_verify_ids UNION ALL SELECT customer_b FROM agsaas_verify_ids)),
  'customer Data API and Realtime authorization excludes other teams');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.activities WHERE team_id IN (SELECT team_a FROM agsaas_verify_ids UNION ALL SELECT team_b FROM agsaas_verify_ids)),
  'notification reads require both recipient identity and current team membership');
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user, 'public.api_keys', 'SELECT')
  AND NOT has_table_privilege(current_user, 'public.inbox_accounts', 'SELECT')
  AND NOT has_column_privilege(current_user, 'public.bank_connections', 'access_token', 'SELECT')
  AND NOT has_column_privilege(current_user, 'public.bank_connections', 'team_id', 'UPDATE'),
  'browser cannot read integration credentials or change bank ownership');
SELECT pg_temp.assert_true(NOT has_function_privilege(current_user, 'public.global_search(text,uuid,text,integer,integer,real)', 'EXECUTE'),
  'browser cannot invoke backend team-parameter SQL through RPC');
UPDATE public.bank_connections SET reference_id = 'reconnected'
WHERE id IN (SELECT bank_a FROM agsaas_verify_ids UNION ALL SELECT bank_b FROM agsaas_verify_ids)
RETURNING id;
DO $denied_mutations$
BEGIN
  BEGIN
    INSERT INTO public.users_on_team (user_id, team_id, role)
    SELECT user_a, team_b, 'owner'::public."teamRoles" FROM agsaas_verify_ids;
    RAISE EXCEPTION 'Authenticated client inserted a membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM access_token FROM public.bank_connections;
    RAISE EXCEPTION 'Authenticated client read an integration credential';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$denied_mutations$;
RESET ROLE;
SELECT pg_temp.assert_true((
  SELECT a.reference_id = 'reconnected' AND b.reference_id IS NULL
  FROM public.bank_connections a, public.bank_connections b, agsaas_verify_ids ids
  WHERE a.id = ids.bank_a AND b.id = ids.bank_b
), 'column-limited bank reconnect changes only an authorized team');

DELETE FROM public.users_on_team WHERE user_id = (SELECT user_a FROM agsaas_verify_ids)
  AND team_id = (SELECT team_a FROM agsaas_verify_ids);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM private.get_teams_for_authenticated_user()),
  'membership revocation is immediate without a JWT refresh');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.customers WHERE id = (SELECT customer_a FROM agsaas_verify_ids)),
  'revoked member loses existing Data API/Realtime read authorization');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user, 'public.customers', 'SELECT')
  AND NOT has_table_privilege(current_user, 'public.users', 'SELECT'),
  'anonymous Data API has no application table privileges');
DO $anonymous_read$
BEGIN
  BEGIN
    PERFORM id FROM public.customers;
    RAISE EXCEPTION 'Anonymous client read an application table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$anonymous_read$;
RESET ROLE;

DELETE FROM auth.users WHERE id = (SELECT user_b FROM agsaas_verify_ids);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.users WHERE id = (SELECT user_b FROM agsaas_verify_ids))
  AND (SELECT count(*) = 0 FROM public.users_on_team WHERE user_id = (SELECT user_b FROM agsaas_verify_ids)),
  'real Auth deletion cascades profile and memberships');

ROLLBACK;
