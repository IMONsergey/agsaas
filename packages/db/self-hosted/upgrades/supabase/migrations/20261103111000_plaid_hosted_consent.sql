-- Native Plaid Hosted Link consent. Existing unverified provider paths stay closed.
-- No FK cascades may discard an uncertain or known external provider grant.
CREATE TABLE public.hosted_bank_consents (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  request_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'plaid'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','production')),
  status text NOT NULL CHECK (status IN (
    'creating','awaiting_consent','exchanging','grant_received','verified','completed',
    'cleanup_requested','cleanup_pending','canceled','reconciliation'
  )),
  claim_token uuid,
  encrypted_payload text NOT NULL CHECK (octet_length(encrypted_payload) <= 524288),
  provider_identity_hash text CHECK (provider_identity_hash ~ '^[0-9a-f]{64}$'),
  connection_id uuid,
  cleanup_id uuid,
  reason text CHECK (reason IN (
    'provider_outcome_unknown','provider_identity_conflict','consent_expired',
    'scope_revoked','account_selection_unavailable','connection_exists',
    'quota_unavailable','provider_cleanup_pending','abandoned_consent_review','invalid_provider_data'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (team_id,user_id,request_id),
  UNIQUE (provider,provider_environment,provider_identity_hash)
);
CREATE INDEX hosted_bank_consents_due_idx ON public.hosted_bank_consents(status,expires_at,id)
  WHERE status NOT IN ('completed','cleanup_pending','canceled','reconciliation');
CREATE INDEX hosted_bank_consents_actor_idx ON public.hosted_bank_consents(team_id,user_id,created_at DESC);
ALTER TABLE public.hosted_bank_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.hosted_bank_consents FOR ALL TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.hosted_bank_consents FROM PUBLIC,anon,authenticated,service_role,agsaas_app;
GRANT SELECT,INSERT,UPDATE ON public.hosted_bank_consents TO agsaas_app;

-- Session revocation and acceptance serialize on the same real Auth rows.
-- The helper exposes only a boolean; no Auth data or mutation is delegated.
CREATE FUNCTION private.lock_hosted_bank_consent_session(p_user uuid,p_session uuid,p_aal text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $agsaas$
BEGIN
  -- The parent lock also fences new MFA-factor FK inserts; existing factor
  -- updates are covered by the row locks below before assurance is evaluated.
  PERFORM 1 FROM auth.users WHERE id=p_user FOR UPDATE;
  PERFORM 1 FROM auth.sessions WHERE id=p_session AND user_id=p_user FOR SHARE;
  PERFORM 1 FROM auth.mfa_factors WHERE user_id=p_user FOR SHARE;
  RETURN private.auth_session_active(p_user,p_session)
    -- now() is fixed at transaction start; a waited lock must not extend a session.
    AND EXISTS (SELECT 1 FROM auth.sessions WHERE id=p_session AND user_id=p_user
      AND (not_after IS NULL OR not_after>clock_timestamp()))
    AND p_aal IN ('aal1','aal2')
    AND (p_aal='aal2' OR NOT EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id=p_user AND status='verified'));
END;
$agsaas$;
REVOKE ALL ON FUNCTION private.lock_hosted_bank_consent_session(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.lock_hosted_bank_consent_session(uuid,uuid,text) TO agsaas_app;

-- Deletion/demotion revokes permission locally before a late provider result.
-- Cleanup consumes the encrypted receipt later; a trigger never performs IO.
CREATE FUNCTION private.cancel_hosted_bank_consents()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $agsaas$
BEGIN
  IF TG_TABLE_SCHEMA='auth' AND TG_TABLE_NAME='sessions' THEN
    UPDATE public.hosted_bank_consents SET status='cleanup_requested',reason='scope_revoked',updated_at=clock_timestamp()
      WHERE session_id=OLD.id AND status NOT IN ('completed','cleanup_pending','canceled');
  ELSIF TG_TABLE_NAME='teams' THEN
    UPDATE public.hosted_bank_consents SET status='cleanup_requested',reason='scope_revoked',updated_at=clock_timestamp()
      WHERE team_id=OLD.id AND status NOT IN ('completed','cleanup_pending','canceled');
  ELSIF TG_TABLE_NAME='users' THEN
    UPDATE public.hosted_bank_consents SET status='cleanup_requested',reason='scope_revoked',updated_at=clock_timestamp()
      WHERE user_id=OLD.id AND status NOT IN ('completed','cleanup_pending','canceled');
  ELSIF TG_OP='DELETE' OR (OLD.role='owner' AND NEW.role IS DISTINCT FROM 'owner') THEN
    UPDATE public.hosted_bank_consents SET status='cleanup_requested',reason='scope_revoked',updated_at=clock_timestamp()
      WHERE team_id=OLD.team_id AND user_id=OLD.user_id AND status NOT IN ('completed','cleanup_pending','canceled');
  END IF;
  RETURN NULL;
END;
$agsaas$;
REVOKE ALL ON FUNCTION private.cancel_hosted_bank_consents() FROM PUBLIC,anon,authenticated,service_role,agsaas_app;
CREATE TRIGGER agsaas_hosted_consent_session_revoked AFTER DELETE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION private.cancel_hosted_bank_consents();
CREATE TRIGGER agsaas_hosted_consent_team_deleted AFTER DELETE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION private.cancel_hosted_bank_consents();
CREATE TRIGGER agsaas_hosted_consent_user_deleted AFTER DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION private.cancel_hosted_bank_consents();
CREATE TRIGGER agsaas_hosted_consent_membership_changed AFTER UPDATE OF role OR DELETE ON public.users_on_team
  FOR EACH ROW EXECUTE FUNCTION private.cancel_hosted_bank_consents();
