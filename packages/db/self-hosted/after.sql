-- This is the only browser-callable helper. Its input is the signed request's
-- Auth subject, never editable user metadata or a supplied team/user ID.
-- SECURITY DEFINER avoids recursively evaluating users_on_team policies.
CREATE FUNCTION private.get_teams_for_authenticated_user()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT DISTINCT membership.team_id FROM public.users_on_team membership
  WHERE membership.user_id = (SELECT auth.uid());
$function$;
REVOKE ALL ON FUNCTION private.get_teams_for_authenticated_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_teams_for_authenticated_user() TO authenticated, agsaas_app, service_role;

-- Synchronous Auth -> application profile creation is necessary for the
-- existing callback/onboarding flow. Team membership is created by createTeam
-- in the API transaction, never trusted from user-controlled metadata.
CREATE FUNCTION private.create_application_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  INSERT INTO public.users (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      CASE WHEN jsonb_typeof(NEW.raw_user_meta_data -> 'full_name') = 'string' THEN NEW.raw_user_meta_data ->> 'full_name' END,
      CASE WHEN jsonb_typeof(NEW.raw_user_meta_data -> 'name') = 'string' THEN NEW.raw_user_meta_data ->> 'name' END
    ),
    COALESCE(
      CASE WHEN jsonb_typeof(NEW.raw_user_meta_data -> 'avatar_url') = 'string' THEN NEW.raw_user_meta_data ->> 'avatar_url' END,
      CASE WHEN jsonb_typeof(NEW.raw_user_meta_data -> 'picture') = 'string' THEN NEW.raw_user_meta_data ->> 'picture' END
    )
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION private.sync_application_profile_email()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  UPDATE public.users SET email = NEW.email WHERE id = NEW.id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.create_application_profile(), private.sync_application_profile_email()
FROM PUBLIC, anon, authenticated, service_role, agsaas_app;

CREATE TRIGGER agsaas_auth_user_created
AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION private.create_application_profile();
CREATE TRIGGER agsaas_auth_email_updated
AFTER UPDATE OF email ON auth.users FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION private.sync_application_profile_email();

-- Only current Data API / Realtime reads are enabled. Every write other than
-- the two bank reconnect columns goes through the tenant-checked application
-- API. Token, integration-secret and membership tables have no browser grants.
GRANT SELECT ON public.users, public.teams, public.inbox, public.documents,
  public.transactions, public.customers, public.activities, public.insights TO authenticated;

CREATE POLICY agsaas_profile_read ON public.users FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));
CREATE POLICY agsaas_team_read ON public.teams FOR SELECT TO authenticated
  USING (id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_inbox_read ON public.inbox FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_document_read ON public.documents FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_transaction_read ON public.transactions FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_customer_read ON public.customers FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_activity_read ON public.activities FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND team_id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_insight_read ON public.insights FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()));

GRANT SELECT (id, team_id), UPDATE (expires_at, reference_id) ON public.bank_connections TO authenticated;
CREATE POLICY agsaas_bank_reconnect_read ON public.bank_connections FOR SELECT TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()));
CREATE POLICY agsaas_bank_reconnect_update ON public.bank_connections FOR UPDATE TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()))
  WITH CHECK (team_id IN (SELECT private.get_teams_for_authenticated_user()));

-- Existing hooks subscribe only to INSERT/UPDATE (activities: INSERT).
-- The original schema also published insights. Membership RLS authorizes each
-- subscription; the client-supplied team filter is not an authorization rule.
DO $realtime$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'Initialize the Supabase Realtime publication before AGSaaS';
  END IF;
END;
$realtime$;
ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox, public.documents,
  public.transactions, public.customers, public.activities, public.insights;
