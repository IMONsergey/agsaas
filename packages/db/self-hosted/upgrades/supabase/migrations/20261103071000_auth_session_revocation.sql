-- Browser access is bound to a current Auth session, including direct Data API.
CREATE OR REPLACE FUNCTION private.auth_session_active(p_user uuid,p_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $agsaas$
 SELECT EXISTS (
   SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
   WHERE s.id=p_session AND s.user_id=p_user
     AND (s.not_after IS NULL OR s.not_after>now())
     AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
 );
$agsaas$;
REVOKE ALL ON FUNCTION private.auth_session_active(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.current_auth_session_active()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $agsaas$
DECLARE sid uuid;
BEGIN
 BEGIN sid:=NULLIF(auth.jwt()->>'session_id','')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
 RETURN sid IS NOT NULL AND private.auth_session_active(auth.uid(),sid);
END;
$agsaas$;
REVOKE ALL ON FUNCTION private.current_auth_session_active() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.current_auth_session_active() TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.own_auth_sessions(p_user uuid)
RETURNS TABLE(id uuid,created_at timestamptz,refreshed_at timestamptz,user_agent text,ip text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $agsaas$
 SELECT s.id,s.created_at,s.refreshed_at AT TIME ZONE 'UTC',left(s.user_agent,250),s.ip::text
 FROM auth.sessions s WHERE s.user_id=p_user AND (s.not_after IS NULL OR s.not_after>now())
 ORDER BY s.created_at DESC NULLS LAST,s.id LIMIT 100;
$agsaas$;
REVOKE ALL ON FUNCTION private.own_auth_sessions(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.revoke_auth_sessions(p_user uuid,p_current uuid,p_scope text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $agsaas$
DECLARE affected integer;
BEGIN
 PERFORM 1 FROM auth.users WHERE id=p_user FOR UPDATE;
 IF p_scope NOT IN ('others','all') OR NOT private.auth_session_active(p_user,p_current) THEN
   RAISE EXCEPTION 'Invalid session revocation request' USING ERRCODE='42501';
 END IF;
 DELETE FROM auth.refresh_tokens WHERE session_id IN (
   SELECT id FROM auth.sessions WHERE user_id=p_user AND (p_scope='all' OR id<>p_current)
 );
 DELETE FROM auth.sessions WHERE user_id=p_user AND (p_scope='all' OR id<>p_current);
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected;
END;
$agsaas$;
REVOKE ALL ON FUNCTION private.revoke_auth_sessions(uuid,uuid,text) FROM PUBLIC,anon,authenticated;

DO $agsaas$
DECLARE role_name text; item record;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['agsaas_app','service_role'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT USAGE ON SCHEMA private TO %I',role_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION private.auth_session_active(uuid,uuid),private.own_auth_sessions(uuid),private.revoke_auth_sessions(uuid,uuid,text) TO %I',role_name);
  END IF;
 END LOOP;
 FOR item IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind='r' AND c.relrowsecurity AND (n.nspname='public' OR (n.nspname='storage' AND c.relname='objects'))
 LOOP
   EXECUTE format('DROP POLICY IF EXISTS agsaas_current_browser_session ON %I.%I',item.nspname,item.relname);
   EXECUTE format('CREATE POLICY agsaas_current_browser_session ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.current_auth_session_active())) WITH CHECK ((SELECT private.current_auth_session_active()))',item.nspname,item.relname);
 END LOOP;
END;
$agsaas$;
