-- Read-only assertions after baseline + upgrades, or after incremental upgrade.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_column_privilege(role_name, 'public.bank_connections', 'reference_id', 'UPDATE')
       OR has_column_privilege(role_name, 'public.bank_connections', 'expires_at', 'UPDATE') THEN
      RAISE EXCEPTION 'Browser role % can rewrite a service-provider consent target', role_name;
    END IF;
    IF has_table_privilege(role_name, 'public.apps', 'SELECT')
       OR has_table_privilege(role_name, 'public.api_keys', 'SELECT') THEN
      RAISE EXCEPTION 'Browser role % can read credential-bearing tables directly', role_name;
    END IF;
  END LOOP;
END $$;
