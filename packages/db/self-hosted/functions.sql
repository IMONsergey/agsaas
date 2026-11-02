-- Real application routines reconstructed from current TypeScript callers.
-- They are SECURITY INVOKER: only the trusted backend/service roles receive
-- EXECUTE, and table privileges/RLS remain in force.

CREATE FUNCTION public.total_duration(project public.tracker_projects)
RETURNS double precision LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT COALESCE(sum(entry.duration), 0)::double precision
  FROM public.tracker_entries entry
  WHERE entry.project_id = project.id AND entry.team_id = project.team_id;
$function$;

CREATE FUNCTION public.get_project_total_amount(project public.tracker_projects)
RETURNS numeric LANGUAGE sql STABLE SET search_path = '' AS $function$
  -- Match getTrackerEntriesByProject: stored seconds * current project hourly
  -- rate. A running timer has NULL duration; billable-only earnings are a
  -- separate application report, not this per-project amount calculation.
  SELECT COALESCE(sum(entry.duration), 0) * COALESCE(project.rate, 0) / 3600
  FROM public.tracker_entries entry
  WHERE entry.project_id = project.id AND entry.team_id = project.team_id;
$function$;

CREATE FUNCTION public.get_assigned_users_for_project(project public.tracker_projects)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', assigned.id, 'full_name', assigned.full_name, 'avatar_url', assigned.avatar_url
  ) ORDER BY assigned.id), '[]'::jsonb)
  FROM (
    SELECT DISTINCT profile.id, profile.full_name, profile.avatar_url
    FROM public.tracker_entries entry
    JOIN public.users profile ON profile.id = entry.assigned_id
    WHERE entry.project_id = project.id AND entry.team_id = project.team_id
      AND EXISTS (
        SELECT 1 FROM public.users_on_team membership
        WHERE membership.team_id = project.team_id AND membership.user_id = profile.id
      )
  ) assigned;
$function$;

CREATE FUNCTION public.get_bank_account_currencies(team_id uuid)
RETURNS TABLE(currency text) LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT DISTINCT account.currency
  FROM public.bank_accounts account
  WHERE account.team_id = $1 AND account.enabled AND account.currency IS NOT NULL
  ORDER BY account.currency;
$function$;

CREATE FUNCTION public.get_team_bank_accounts_balances(team_id uuid)
RETURNS TABLE(id uuid, currency text, balance double precision, name text, logo_url text)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT account.id, account.currency, COALESCE(account.balance, 0)::double precision,
    COALESCE(account.name, connection.name, ''), COALESCE(connection.logo_url, '')
  FROM public.bank_accounts account
  LEFT JOIN public.bank_connections connection
    ON connection.id = account.bank_connection_id AND connection.team_id = account.team_id
  WHERE account.team_id = $1 AND account.enabled AND account.currency IS NOT NULL
  ORDER BY account.created_at, account.id;
$function$;

-- Only built-in PostgreSQL configurations are accepted. Unknown language
-- codes fall back to simple tokenization, never dynamic SQL or an exception
-- during document ingestion. ISO codes mirror the document worker mapping.
CREATE FUNCTION private.text_search_config(language text)
RETURNS regconfig LANGUAGE sql STABLE PARALLEL SAFE SET search_path = '' AS $function$
  WITH requested AS (
    SELECT CASE lower(trim(COALESCE(language, 'english')))
      WHEN 'en' THEN 'english' WHEN 'sv' THEN 'swedish'
      WHEN 'da' THEN 'danish' WHEN 'no' THEN 'norwegian'
      WHEN 'de' THEN 'german' WHEN 'fr' THEN 'french'
      WHEN 'es' THEN 'spanish' WHEN 'it' THEN 'italian'
      WHEN 'pt' THEN 'portuguese' WHEN 'ru' THEN 'russian'
      WHEN 'nl' THEN 'dutch' WHEN 'fi' THEN 'finnish'
      WHEN 'pl' THEN 'polish' WHEN 'tr' THEN 'turkish'
      WHEN 'cs' THEN 'czech' WHEN 'hu' THEN 'hungarian'
      WHEN 'ro' THEN 'romanian'
      ELSE lower(trim(COALESCE(language, 'english')))
    END AS name
  )
  SELECT COALESCE((
    SELECT config.oid::regconfig
    FROM pg_catalog.pg_ts_config config
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = config.cfgnamespace
    WHERE namespace.nspname = 'pg_catalog' AND config.cfgname = requested.name
  ), 'pg_catalog.simple'::regconfig)
  FROM requested;
$function$;

CREATE FUNCTION private.prefix_search_query(term text, configuration regconfig)
RETURNS tsquery LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $function$
  -- Tokenize first, then quote lexemes; punctuation is never interpreted as
  -- caller-supplied tsquery syntax. Prefix matching is applied to each token.
  SELECT to_tsquery(configuration, string_agg(quote_literal(lexeme) || ':*', ' & ' ORDER BY lexeme))
  FROM unnest(tsvector_to_array(to_tsvector(configuration, COALESCE(term, '')))) AS lexeme;
$function$;

CREATE FUNCTION private.update_document_search_vectors()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE
  searchable text;
BEGIN
  searchable := concat_ws(' ', NEW.title, NEW.name, NEW.summary, NEW.body, NEW.content);
  NEW.fts_simple := to_tsvector('pg_catalog.simple'::regconfig, searchable);
  NEW.fts_english := to_tsvector('pg_catalog.english'::regconfig, searchable);
  NEW.fts_language := to_tsvector(private.text_search_config(COALESCE(NEW.language, 'simple')), searchable);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agsaas_document_search_vectors
BEFORE INSERT OR UPDATE OF title, name, summary, body, content, language
ON public.documents FOR EACH ROW EXECUTE FUNCTION private.update_document_search_vectors();

CREATE FUNCTION public.match_similar_documents_by_title(
  source_document_id uuid, p_team_id uuid, match_threshold double precision, match_count integer
)
RETURNS TABLE(
  id uuid, name text, metadata jsonb, path_tokens text[], tag text,
  title text, summary text, title_similarity real
)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT candidate.id, candidate.name, candidate.metadata, candidate.path_tokens,
    candidate.tag, candidate.title, candidate.summary,
    extensions.similarity(candidate.title, source.title) AS title_similarity
  FROM public.documents source
  JOIN public.documents candidate ON candidate.team_id = source.team_id AND candidate.id <> source.id
  WHERE source.id = source_document_id AND source.team_id = p_team_id
    AND source.title IS NOT NULL AND candidate.title IS NOT NULL
    AND extensions.similarity(candidate.title, source.title) >= greatest(0, least(COALESCE(match_threshold, 0.3), 1))
  ORDER BY title_similarity DESC, candidate.created_at DESC NULLS LAST, candidate.id
  LIMIT greatest(1, least(COALESCE(match_count, 20), 100));
$function$;

-- Despite its historical name, this routine is filtered lexical search.
-- The TypeScript caller supplies text/date/amount filters, NOT a vector.
CREATE FUNCTION public.global_semantic_search(
  p_team_id uuid,
  p_search_term text DEFAULT NULL,
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL,
  p_types text[] DEFAULT NULL,
  p_amount numeric DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_due_date_start text DEFAULT NULL,
  p_due_date_end text DEFAULT NULL,
  p_max_results integer DEFAULT 20,
  p_items_per_table_limit integer DEFAULT 5
)
RETURNS TABLE(id uuid, type text, title text, relevance real, created_at timestamptz, data jsonb)
LANGUAGE plpgsql STABLE SET search_path = '' AS $function$
DECLARE
  configuration regconfig := private.text_search_config(p_language);
  query tsquery := private.prefix_search_query(p_search_term, configuration);
  requested_types text[] := COALESCE(NULLIF(p_types, ARRAY[]::text[]),
    ARRAY['transactions', 'invoices', 'customers', 'documents', 'inbox', 'tracker_projects']);
BEGIN
  IF p_team_id IS NULL THEN RETURN; END IF;
  -- A nonempty query containing only punctuation/stop words must not turn
  -- into an unfiltered search of the user's financial data.
  IF trim(COALESCE(p_search_term, '')) <> '' AND query IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH source AS (
    SELECT item.id, 'transaction'::text AS kind, item.name AS label, item.created_at,
      to_jsonb(item) - 'fts_vector' AS data,
      concat_ws(' ', item.name, item.description) AS searchable,
      item.date AS event_date, item.amount AS amount_value, item.currency AS currency_value,
      item.status::text AS status_value, NULL::date AS due_date
    FROM public.transactions AS item
    WHERE item.team_id = p_team_id AND ('transactions' = ANY(requested_types) OR 'transaction' = ANY(requested_types))
    UNION ALL
    SELECT item.id, 'invoice', COALESCE(item.invoice_number, item.customer_name, ''), item.created_at,
      to_jsonb(item) - 'fts',
      concat_ws(' ', item.invoice_number, item.customer_name, item.amount::text, item.note),
      COALESCE((item.issue_date AT TIME ZONE 'UTC')::date, (item.created_at AT TIME ZONE 'UTC')::date),
      item.amount, item.currency, item.status::text, (item.due_date AT TIME ZONE 'UTC')::date
    FROM public.invoices AS item
    WHERE item.team_id = p_team_id AND ('invoices' = ANY(requested_types) OR 'invoice' = ANY(requested_types))
    UNION ALL
    SELECT item.id, 'customer', item.name, item.created_at, to_jsonb(item) - 'fts',
      concat_ws(' ', item.name, item.contact, item.email, item.phone, item.address_line_1,
        item.address_line_2, item.city, item.state, item.zip, item.country),
      (item.created_at AT TIME ZONE 'UTC')::date, NULL::numeric, NULL::text, item.status, NULL::date
    FROM public.customers AS item
    WHERE item.team_id = p_team_id AND ('customers' = ANY(requested_types) OR 'customer' = ANY(requested_types))
    UNION ALL
    SELECT item.id, 'vault', COALESCE(item.title, item.name, ''), item.created_at,
      to_jsonb(item) - ARRAY['fts', 'fts_simple', 'fts_english', 'fts_language'],
      concat_ws(' ', item.title, item.name, item.summary, item.body, item.content),
      COALESCE(item.date, (item.created_at AT TIME ZONE 'UTC')::date), NULL::numeric, NULL::text, NULL::text, NULL::date
    FROM public.documents AS item
    WHERE item.team_id = p_team_id AND ('documents' = ANY(requested_types) OR 'vault' = ANY(requested_types))
      AND COALESCE(item.name, '') NOT LIKE '%.folderPlaceholder'
    UNION ALL
    SELECT item.id, 'inbox', COALESCE(item.display_name, item.file_name, ''), item.created_at,
      to_jsonb(item) - 'fts',
      concat_ws(' ', item.display_name, item.file_name, item.description, item.invoice_number,
        public.extract_product_names(item.meta -> 'products')),
      COALESCE(item.date, (item.created_at AT TIME ZONE 'UTC')::date), item.amount, item.currency, item.status::text, NULL::date
    FROM public.inbox AS item
    WHERE item.team_id = p_team_id AND 'inbox' = ANY(requested_types)
    UNION ALL
    SELECT item.id, 'tracker_project', item.name, item.created_at, to_jsonb(item) - 'fts',
      concat_ws(' ', item.name, item.description), (item.created_at AT TIME ZONE 'UTC')::date,
      NULL::numeric, item.currency, item.status::text, NULL::date
    FROM public.tracker_projects AS item
    WHERE item.team_id = p_team_id AND ('tracker_projects' = ANY(requested_types) OR 'tracker_project' = ANY(requested_types))
  ), filtered AS (
    SELECT source.*, to_tsvector(configuration, COALESCE(source.searchable, '')) AS vector
    FROM source
    WHERE (p_start_date IS NULL OR source.event_date >= p_start_date::date)
      AND (p_end_date IS NULL OR source.event_date <= p_end_date::date)
      AND (source.kind NOT IN ('transaction', 'invoice', 'inbox') OR (
        (p_amount IS NULL OR source.amount_value = p_amount)
        AND (p_amount_min IS NULL OR source.amount_value >= p_amount_min)
        AND (p_amount_max IS NULL OR source.amount_value <= p_amount_max)
      ))
      AND (p_currency IS NULL OR source.kind NOT IN ('transaction', 'invoice', 'inbox', 'tracker_project')
        OR upper(source.currency_value) = upper(p_currency))
      AND (p_status IS NULL OR source.kind NOT IN ('transaction', 'invoice', 'inbox', 'tracker_project')
        OR source.status_value = p_status)
      AND (p_due_date_start IS NULL OR (source.kind = 'invoice' AND source.due_date >= p_due_date_start::date))
      AND (p_due_date_end IS NULL OR (source.kind = 'invoice' AND source.due_date <= p_due_date_end::date))
  ), scored AS (
    SELECT filtered.*, CASE WHEN query IS NULL THEN 0::real ELSE ts_rank_cd(filtered.vector, query, 32) END AS score
    FROM filtered WHERE query IS NULL OR filtered.vector @@ query
  ), ranked AS (
    SELECT scored.*, row_number() OVER (
      PARTITION BY scored.kind ORDER BY scored.score DESC, scored.created_at DESC NULLS LAST, scored.id
    ) AS position
    FROM scored
  )
  SELECT ranked.id, ranked.kind, COALESCE(ranked.label, ''), ranked.score,
    COALESCE(ranked.created_at, 'epoch'::timestamptz), ranked.data
  FROM ranked
  WHERE ranked.position <= greatest(1, least(COALESCE(p_items_per_table_limit, 5), 100))
  ORDER BY ranked.score DESC, ranked.created_at DESC NULLS LAST, ranked.kind, ranked.id
  LIMIT greatest(1, least(COALESCE(p_max_results, 20), 1000));
END;
$function$;

CREATE FUNCTION public.global_search(
  p_search_term text, p_team_id uuid, p_search_lang text DEFAULT 'english',
  p_limit integer DEFAULT 30, p_items_per_table_limit integer DEFAULT 5,
  p_relevance_threshold real DEFAULT 0.01
)
RETURNS TABLE(id uuid, type text, title text, relevance real, created_at timestamptz, data jsonb)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT result.* FROM public.global_semantic_search(
    p_team_id, p_search_term, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    p_search_lang, NULL, NULL, COALESCE(p_limit, 30), COALESCE(p_items_per_table_limit, 5)
  ) result
  WHERE trim(COALESCE(p_search_term, '')) = ''
    OR result.relevance >= greatest(0, least(COALESCE(p_relevance_threshold, 0.01), 1))
  ORDER BY result.relevance DESC, result.created_at DESC, result.type, result.id;
$function$;

REVOKE ALL ON FUNCTION
  public.total_duration(public.tracker_projects),
  public.get_project_total_amount(public.tracker_projects),
  public.get_assigned_users_for_project(public.tracker_projects),
  public.get_bank_account_currencies(uuid),
  public.get_team_bank_accounts_balances(uuid),
  public.match_similar_documents_by_title(uuid, uuid, double precision, integer),
  public.global_semantic_search(uuid, text, text, text, text[], numeric, numeric, numeric, text, text, text, text, text, integer, integer),
  public.global_search(text, uuid, text, integer, integer, real),
  private.text_search_config(text), private.prefix_search_query(text, regconfig),
  private.update_document_search_vectors()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.total_duration(public.tracker_projects),
  public.get_project_total_amount(public.tracker_projects),
  public.get_assigned_users_for_project(public.tracker_projects),
  public.get_bank_account_currencies(uuid),
  public.get_team_bank_accounts_balances(uuid),
  public.match_similar_documents_by_title(uuid, uuid, double precision, integer),
  public.global_semantic_search(uuid, text, text, text, text[], numeric, numeric, numeric, text, text, text, text, text, integer, integer),
  public.global_search(text, uuid, text, integer, integer, real),
  private.text_search_config(text), private.prefix_search_query(text, regconfig),
  private.update_document_search_vectors()
TO agsaas_app, service_role;
