-- Own browser upload boundary. Vault is private; only deliberately displayed
-- raster image assets live in public buckets. Existing data is never published.
DO $preflight$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL
    OR to_regprocedure('private.current_auth_session_active()') IS NULL
    OR to_regprocedure('private.session_has_required_assurance()') IS NULL
    OR to_regprocedure('private.vault_key_team(text)') IS NULL THEN
    RAISE EXCEPTION 'Initialize Storage, active sessions, MFA and canonical Vault ingestion before access policies';
  END IF;
END;
$preflight$;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('vault','vault',false,52428800,NULL)
ON CONFLICT(id) DO NOTHING;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('avatars','avatars',true,5242880,ARRAY['image/jpeg','image/png','image/webp','image/gif']),
       ('apps','apps',true,5242880,ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT(id) DO NOTHING;

DO $bucket_contract$
BEGIN
  IF EXISTS(SELECT 1 FROM storage.buckets WHERE id='vault'
    AND (public OR file_size_limit IS DISTINCT FROM 52428800 OR allowed_mime_types IS NOT NULL)) THEN
    RAISE EXCEPTION 'Existing Vault bucket differs from the private 50 MiB contract; reconcile explicitly';
  END IF;
  IF EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('avatars','apps')
    AND (NOT public OR file_size_limit IS DISTINCT FROM 5242880
      OR allowed_mime_types IS NULL OR cardinality(allowed_mime_types)<>4
      OR NOT allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp','image/gif'])) THEN
    RAISE EXCEPTION 'Existing asset bucket differs from the intended-public raster image contract; no visibility change is automatic';
  END IF;
END;
$bucket_contract$;

CREATE OR REPLACE FUNCTION private.can_access_vault_object(object_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT private.current_auth_session_active()
    AND private.session_has_required_assurance()
    AND private.vault_key_team(object_name) IN (SELECT private.get_teams_for_authenticated_user());
$function$;

CREATE OR REPLACE FUNCTION private.can_write_public_image(bucket text, object_name text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $function$
DECLARE parts text[]; subject uuid; team uuid;
BEGIN
  IF private.current_auth_session_active() IS DISTINCT FROM true OR private.session_has_required_assurance() IS DISTINCT FROM true
    OR object_name IS NULL OR length(object_name)>300 THEN RETURN false; END IF;
  parts := string_to_array(object_name,'/');
  IF array_position(parts,'') IS NOT NULL OR '.'=ANY(parts) OR '..'=ANY(parts)
    OR parts[cardinality(parts)] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif)$'
    THEN RETURN false; END IF;
  subject := auth.uid();
  IF bucket='avatars' AND cardinality(parts)=3 AND parts[1]='users'
    THEN RETURN parts[2]=subject::text; END IF;
  IF bucket='avatars' AND cardinality(parts)=4 AND parts[1]='teams' AND parts[3] IN ('logo','invoice')
    AND parts[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN team:=parts[2]::uuid;
  ELSIF bucket='apps' AND cardinality(parts)=3 AND parts[2] IN ('logos','screenshots')
    AND parts[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN team:=parts[1]::uuid;
  ELSE RETURN false; END IF;
  RETURN team IN (SELECT private.get_teams_for_authenticated_user())
    AND EXISTS(SELECT 1 FROM public.users_on_team WHERE user_id=subject AND team_id=team AND role='owner');
END;
$function$;
REVOKE ALL ON FUNCTION private.can_access_vault_object(text),private.can_write_public_image(text,text) FROM PUBLIC,anon,authenticated,agsaas_app,service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_access_vault_object(text),private.can_write_public_image(text,text) TO authenticated;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agsaas_storage_read ON storage.objects;
CREATE POLICY agsaas_storage_read ON storage.objects FOR SELECT TO authenticated USING
  ((bucket_id='vault' AND private.can_access_vault_object(name))
   OR (bucket_id IN ('avatars','apps') AND private.can_write_public_image(bucket_id,name)));
DROP POLICY IF EXISTS agsaas_storage_insert ON storage.objects;
CREATE POLICY agsaas_storage_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK
  ((bucket_id='vault' AND private.can_access_vault_object(name))
   OR (bucket_id IN ('avatars','apps') AND private.can_write_public_image(bucket_id,name)));
DROP POLICY IF EXISTS agsaas_storage_update ON storage.objects;
CREATE POLICY agsaas_storage_update ON storage.objects FOR UPDATE TO authenticated
  USING(bucket_id='vault' AND private.can_access_vault_object(name))
  WITH CHECK(bucket_id='vault' AND private.can_access_vault_object(name));
DROP POLICY IF EXISTS agsaas_storage_delete ON storage.objects;
CREATE POLICY agsaas_storage_delete ON storage.objects FOR DELETE TO authenticated USING
  ((bucket_id='vault' AND private.can_access_vault_object(name))
   OR (bucket_id IN ('avatars','apps') AND private.can_write_public_image(bucket_id,name)));

-- A future permissive policy cannot silently undo these installation boundaries.
DROP POLICY IF EXISTS agsaas_storage_scope ON storage.objects;
CREATE POLICY agsaas_storage_scope ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING(bucket_id NOT IN ('vault','avatars','apps')
    OR (bucket_id='vault' AND private.can_access_vault_object(name))
    OR (bucket_id IN ('avatars','apps') AND private.can_write_public_image(bucket_id,name)))
  WITH CHECK(bucket_id NOT IN ('vault','avatars','apps')
    OR (bucket_id='vault' AND private.can_access_vault_object(name))
    OR (bucket_id IN ('avatars','apps') AND private.can_write_public_image(bucket_id,name)));
DROP POLICY IF EXISTS agsaas_public_images_immutable ON storage.objects;
CREATE POLICY agsaas_public_images_immutable ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING(bucket_id NOT IN ('avatars','apps')) WITH CHECK(bucket_id NOT IN ('avatars','apps'));
DROP POLICY IF EXISTS agsaas_storage_no_anonymous_catalog ON storage.objects;
CREATE POLICY agsaas_storage_no_anonymous_catalog ON storage.objects AS RESTRICTIVE FOR ALL TO anon
  USING(bucket_id NOT IN ('vault','avatars','apps')) WITH CHECK(bucket_id NOT IN ('vault','avatars','apps'));
NOTIFY pgrst,'reload schema';
