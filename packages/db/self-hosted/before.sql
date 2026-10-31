-- Platform bootstrap must finish first. Never create fake Auth functions,
-- roles, users, or platform tables to make the application DDL appear to work.
DO $platform_prerequisites$
BEGIN
  IF to_regclass('auth.users') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'Initialize the pinned Supabase Auth schema before AGSaaS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'Supabase API roles are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'agsaas_app' AND r.rolcanlogin
      AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
      AND NOT r.rolinherit AND NOT r.rolbypassrls AND NOT r.rolreplication
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
  ) THEN
    RAISE EXCEPTION 'Provision the dedicated nonprivileged agsaas_app LOGIN role first (NOINHERIT, NOBYPASSRLS, no role memberships)';
  END IF;
END;
$platform_prerequisites$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $extension_namespaces$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname IN ('vector', 'pg_trgm', 'pgcrypto') AND n.nspname <> 'extensions'
  ) THEN
    RAISE EXCEPTION 'Fresh AGSaaS expects vector, pg_trgm, and pgcrypto in extensions; review existing extension placement instead of moving it automatically';
  END IF;
END;
$extension_namespaces$;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, agsaas_app;
GRANT USAGE ON SCHEMA private TO authenticated, agsaas_app, service_role;
GRANT USAGE ON SCHEMA public, extensions TO agsaas_app, service_role;
GRANT USAGE ON SCHEMA public TO authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated, agsaas_app;
ALTER ROLE agsaas_app SET search_path = public, extensions;
SET LOCAL search_path = public, extensions;

-- Random lowercase email-safe inbox aliases; no constant/default placeholder.
CREATE FUNCTION public.generate_inbox(size integer DEFAULT 10)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = '' AS $function$
DECLARE
  alphabet constant text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  result text := '';
  random_bytes bytea;
  value integer;
  position integer;
BEGIN
  IF size IS NULL OR size < 1 OR size > 64 THEN
    RAISE EXCEPTION 'Inbox alias size must be between 1 and 64' USING ERRCODE = '22023';
  END IF;
  WHILE length(result) < size LOOP
    random_bytes := extensions.gen_random_bytes(32);
    FOR position IN 0..31 LOOP
      value := get_byte(random_bytes, position);
      -- Rejection sampling avoids modulo bias: 252 is divisible by 36.
      IF value < 252 THEN
        result := result || substr(alphabet, (value % 36) + 1, 1);
        EXIT WHEN length(result) = size;
      END IF;
    END LOOP;
  END LOOP;
  RETURN result;
END;
$function$;

-- URL-safe invitation tokens. Taking 24 base64 characters from independent
-- cryptographic bytes retains 144 random bits; no Math.random()/constant code.
CREATE FUNCTION public.nanoid(size integer DEFAULT 21)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = '' AS $function$
BEGIN
  IF size IS NULL OR size < 1 OR size > 64 THEN
    RAISE EXCEPTION 'Token size must be between 1 and 64' USING ERRCODE = '22023';
  END IF;
  RETURN substr(translate(encode(extensions.gen_random_bytes(size), 'base64'), '+/=', '-_'), 1, size);
END;
$function$;

-- Historical inbox metadata may contain strings or {name, description}
-- objects. NULL/non-array metadata is searchable as an empty product list.
CREATE FUNCTION public.extract_product_names(data json)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $function$
  SELECT COALESCE(string_agg(
    CASE json_typeof(item)
      WHEN 'string' THEN item #>> '{}'
      WHEN 'object' THEN COALESCE(item ->> 'name', item ->> 'description', '')
      ELSE ''
    END, ' ' ORDER BY ordinal
  ), '')
  FROM json_array_elements(
    CASE WHEN json_typeof(data) = 'array' THEN data ELSE '[]'::json END
  ) WITH ORDINALITY AS products(item, ordinal);
$function$;

CREATE FUNCTION public.generate_inbox_fts(name text, products text)
RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $function$
  SELECT setweight(to_tsvector('pg_catalog.english'::regconfig, COALESCE(name, '')), 'A')
    || setweight(to_tsvector('pg_catalog.english'::regconfig, COALESCE(products, '')), 'B');
$function$;

REVOKE ALL ON FUNCTION public.generate_inbox(integer), public.nanoid(integer), public.extract_product_names(json), public.generate_inbox_fts(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_inbox(integer), public.nanoid(integer), public.extract_product_names(json), public.generate_inbox_fts(text, text) TO agsaas_app, service_role;
