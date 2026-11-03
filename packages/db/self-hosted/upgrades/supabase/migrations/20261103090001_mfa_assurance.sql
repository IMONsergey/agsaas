-- Mandatory incremental assurance gate for Data API and Realtime.
-- Apply through the ordered self-hosted upgrade runner, never rewrite baseline history.
DO $preflight$
BEGIN
  IF to_regclass('auth.mfa_factors') IS NULL THEN
    RAISE EXCEPTION 'Authoritative Auth factor catalog is required for the assurance policy';
  END IF;
END;
$preflight$;

-- Match the application API policy: a verified factor requires a signed
-- top-level AAL2 claim. Unverified factors do not lock out enrollment, and
-- editable user metadata is never an assurance source. No user-id argument.
CREATE OR REPLACE FUNCTION private.session_has_required_assurance()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (
      COALESCE((SELECT auth.jwt()) ->> 'aal', 'aal1') = 'aal2'
      OR NOT EXISTS (
        SELECT 1 FROM auth.mfa_factors AS factor
        WHERE factor.user_id = (SELECT auth.uid())
          AND factor.status = 'verified'
      )
    );
$function$;
REVOKE ALL ON FUNCTION private.session_has_required_assurance() FROM PUBLIC, anon, authenticated, agsaas_app, service_role;
GRANT EXECUTE ON FUNCTION private.session_has_required_assurance() TO authenticated;

CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT DISTINCT membership.team_id
  FROM public.users_on_team AS membership
  WHERE membership.user_id = (SELECT auth.uid())
    AND (SELECT private.session_has_required_assurance());
$function$;
REVOKE ALL ON FUNCTION private.get_teams_for_authenticated_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_teams_for_authenticated_user() TO authenticated, agsaas_app, service_role;

-- A restrictive policy also protects the profile read and every existing
-- browser reconnect write. It cannot be bypassed by another permissive
-- membership policy. Service/API roles retain their existing authorization.
DO $policies$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'users', 'teams', 'inbox', 'documents', 'transactions', 'customers',
    'activities', 'insights', 'bank_connections'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS agsaas_authenticated_assurance ON public.%I', relation_name);
    EXECUTE format(
      'CREATE POLICY agsaas_authenticated_assurance ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.session_has_required_assurance())) WITH CHECK ((SELECT private.session_has_required_assurance()))',
      relation_name
    );
  END LOOP;
END;
$policies$;
NOTIFY pgrst, 'reload schema';
