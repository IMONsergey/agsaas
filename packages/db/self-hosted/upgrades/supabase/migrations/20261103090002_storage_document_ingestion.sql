-- Transactional Storage -> Vault metadata projection. No external webhook.
-- Existing baseline and previously applied migration bytes remain immutable.
DO $preflight$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'Initialize the Storage object catalog before document ingestion';
  END IF;
  IF EXISTS (
    SELECT object_id FROM public.documents WHERE object_id IS NOT NULL
    GROUP BY object_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT team_id, path_tokens FROM public.documents
    WHERE team_id IS NOT NULL AND path_tokens IS NOT NULL
    GROUP BY team_id, path_tokens HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate document identities require operator reconciliation before ingestion upgrade';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS documents_storage_object_key
  ON public.documents(object_id) WHERE object_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS documents_storage_path_key
  ON public.documents(team_id, path_tokens)
  WHERE team_id IS NOT NULL AND path_tokens IS NOT NULL;

CREATE TABLE IF NOT EXISTS private.storage_document_projection (
  object_id uuid PRIMARY KEY REFERENCES storage.objects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL UNIQUE REFERENCES public.documents(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  source_revision text NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.storage_document_projection FROM PUBLIC, anon, authenticated, agsaas_app, service_role;

CREATE OR REPLACE FUNCTION private.vault_key_team(object_name text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $function$
DECLARE parts text[];
BEGIN
  IF object_name IS NULL OR length(object_name) > 1024
    OR object_name ~ '[%?#[:cntrl:]]'
    OR position(chr(92) in object_name) > 0 THEN RETURN NULL; END IF;
  parts := string_to_array(object_name, '/');
  IF cardinality(parts) < 2 OR array_position(parts, '') IS NOT NULL
    OR '.' = ANY(parts) OR '..' = ANY(parts)
    OR parts[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN RETURN NULL; END IF;
  RETURN parts[1]::uuid;
END;
$function$;

CREATE OR REPLACE FUNCTION private.storage_document_revision(object_data jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT md5(COALESCE(object_data ->> 'version', '') || '|' ||
    COALESCE(object_data -> 'metadata', '{}'::jsonb)::text);
$function$;

CREATE OR REPLACE FUNCTION private.project_vault_object(source_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  source_object storage.objects%ROWTYPE;
  document public.documents%ROWTYPE;
  projection private.storage_document_projection%ROWTYPE;
  object_data jsonb;
  target_team uuid;
  object_owner uuid;
  tokens text[];
  revision text;
  changed_content boolean;
  projected_before boolean;
  had_document boolean;
BEGIN
  SELECT * INTO source_object FROM storage.objects WHERE id = source_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ignored'; END IF;
  object_data := to_jsonb(source_object);
  IF source_object.bucket_id <> 'vault'
    OR object_data ->> 'archived_at' IS NOT NULL
    OR object_data ->> 'is_delete_marker' = 'true' THEN
    DELETE FROM public.documents WHERE object_id = source_id;
    DELETE FROM private.storage_document_projection WHERE object_id = source_id;
    RETURN 'ignored';
  END IF;
  target_team := private.vault_key_team(source_object.name);
  IF target_team IS NULL OR NOT EXISTS (SELECT 1 FROM public.teams WHERE id = target_team) THEN
    RETURN 'invalid';
  END IF;
  tokens := string_to_array(source_object.name, '/');
  revision := private.storage_document_revision(object_data);
  -- Serialize projection/adoption for one path as well as one source object.
  PERFORM pg_advisory_xact_lock(hashtextextended('agsaas-vault:' || source_object.name, 0));
  SELECT * INTO projection FROM private.storage_document_projection
    WHERE object_id = source_id FOR UPDATE;
  projected_before := FOUND;
  IF projected_before AND projection.team_id <> target_team THEN
    RAISE EXCEPTION 'A projected Storage object cannot move between teams';
  END IF;
  SELECT * INTO document FROM public.documents
    WHERE object_id = source_id FOR UPDATE;
  had_document := FOUND;
  IF had_document AND document.team_id IS DISTINCT FROM target_team THEN
    RAISE EXCEPTION 'Storage and document team ownership disagree';
  END IF;
  IF NOT had_document THEN
    SELECT * INTO document FROM public.documents
      WHERE team_id = target_team AND path_tokens = tokens FOR UPDATE;
    had_document := FOUND;
    IF had_document AND document.object_id IS NOT NULL AND document.object_id <> source_id THEN
      RAISE EXCEPTION 'A document path is already bound to another Storage object';
    END IF;
  END IF;
  changed_content := (projected_before AND projection.source_revision <> revision)
    OR COALESCE(document.metadata ->> 'storageMissing', 'false') = 'true';
  IF COALESCE(object_data ->> 'owner_id', object_data ->> 'owner', '') ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO object_owner FROM public.users
      WHERE id = COALESCE(object_data ->> 'owner_id', object_data ->> 'owner')::uuid;
  END IF;
  IF projected_before AND had_document AND NOT changed_content
    AND document.name = source_object.name AND document.path_tokens = tokens
    AND document.owner_id IS NOT DISTINCT FROM object_owner THEN
    RETURN 'unchanged';
  END IF;
  IF had_document THEN
    UPDATE public.documents SET
      object_id = source_id, name = source_object.name, path_tokens = tokens,
      parent_id = array_to_string(tokens[1:cardinality(tokens)-1], '/'),
      owner_id = object_owner, metadata = COALESCE(source_object.metadata, '{}'::jsonb),
      title = CASE WHEN changed_content THEN tokens[cardinality(tokens)] ELSE COALESCE(title, tokens[cardinality(tokens)]) END,
      body = CASE WHEN changed_content THEN '' ELSE COALESCE(body, '') END,
      summary = CASE WHEN changed_content THEN NULL ELSE summary END,
      content = CASE WHEN changed_content THEN NULL ELSE content END,
      processing_status = CASE WHEN changed_content THEN 'pending'::public.document_processing_status ELSE COALESCE(processing_status, 'pending'::public.document_processing_status) END
    WHERE id = document.id;
  ELSE
    INSERT INTO public.documents(
      name, team_id, object_id, owner_id, path_tokens, parent_id, metadata,
      title, body, processing_status, created_at
    ) VALUES (
      source_object.name, target_team, source_id, object_owner, tokens,
      array_to_string(tokens[1:cardinality(tokens)-1], '/'),
      COALESCE(source_object.metadata, '{}'::jsonb), tokens[cardinality(tokens)], '',
      'pending', COALESCE(source_object.created_at, now())
    ) RETURNING * INTO document;
  END IF;
  INSERT INTO private.storage_document_projection(object_id, document_id, team_id, source_revision)
    VALUES(source_id, document.id, target_team, revision)
    ON CONFLICT(object_id) DO UPDATE SET document_id=EXCLUDED.document_id,
      source_revision=EXCLUDED.source_revision, projected_at=now();
  RETURN CASE WHEN had_document THEN 'updated' ELSE 'created' END;
END;
$function$;

CREATE OR REPLACE FUNCTION private.on_vault_object_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.documents WHERE object_id = OLD.id;
    DELETE FROM private.storage_document_projection WHERE object_id = OLD.id;
    RETURN OLD;
  END IF;
  IF private.project_vault_object(NEW.id) = 'invalid' THEN
    RAISE EXCEPTION 'Vault objects require a canonical existing team namespace';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS agsaas_storage_document_projection ON storage.objects;
CREATE TRIGGER agsaas_storage_document_projection
  AFTER INSERT OR UPDATE OR DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION private.on_vault_object_changed();

-- Recover legacy/missed projection using current authoritative objects, never
-- replay stale event payloads. Limit work and skip locked uploads. Missing
-- objects are flagged instead of silently destroying recoverable metadata.
CREATE OR REPLACE FUNCTION private.reconcile_storage_documents(batch_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  candidate record;
  outcome text;
  created_count integer := 0;
  updated_count integer := 0;
  missing_count integer := 0;
BEGIN
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 200 THEN
    RAISE EXCEPTION 'Document reconciliation batch must be between 1 and 200';
  END IF;
  FOR candidate IN
    SELECT object.id FROM storage.objects AS object
    JOIN public.teams AS team ON team.id = private.vault_key_team(object.name)
    LEFT JOIN private.storage_document_projection AS projection ON projection.object_id=object.id
    LEFT JOIN public.documents AS document ON document.id=projection.document_id
    WHERE object.bucket_id='vault'
      AND to_jsonb(object)->>'archived_at' IS NULL
      AND COALESCE(to_jsonb(object)->>'is_delete_marker', 'false') <> 'true'
      AND (projection.object_id IS NULL OR document.id IS NULL
        OR projection.source_revision <> private.storage_document_revision(to_jsonb(object))
        OR document.name IS DISTINCT FROM object.name
        OR COALESCE(document.metadata->>'storageMissing', 'false') = 'true')
    ORDER BY object.id LIMIT batch_limit FOR UPDATE OF object SKIP LOCKED
  LOOP
    outcome := private.project_vault_object(candidate.id);
    IF outcome='created' THEN created_count:=created_count+1; END IF;
    IF outcome='updated' THEN updated_count:=updated_count+1; END IF;
  END LOOP;
  FOR candidate IN
    SELECT document.id FROM public.documents AS document
    WHERE document.object_id IS NOT NULL
      AND COALESCE(document.metadata->>'storageMissing', 'false') <> 'true'
      AND NOT EXISTS (
        SELECT 1 FROM storage.objects AS object WHERE object.id=document.object_id
          AND object.bucket_id='vault'
          AND to_jsonb(object)->>'archived_at' IS NULL
          AND COALESCE(to_jsonb(object)->>'is_delete_marker', 'false') <> 'true'
      )
    ORDER BY document.id LIMIT batch_limit FOR UPDATE OF document SKIP LOCKED
  LOOP
    UPDATE public.documents SET processing_status='failed',
      metadata=COALESCE(metadata, '{}'::jsonb) || '{"storageMissing":true}'::jsonb
      WHERE id=candidate.id;
    missing_count:=missing_count+1;
  END LOOP;
  RETURN jsonb_build_object('created',created_count,'updated',updated_count,'missing',missing_count);
END;
$function$;

REVOKE ALL ON FUNCTION private.vault_key_team(text), private.storage_document_revision(jsonb),
  private.project_vault_object(uuid), private.on_vault_object_changed(),
  private.reconcile_storage_documents(integer) FROM PUBLIC, anon, authenticated, agsaas_app, service_role;
-- Function EXECUTE also requires namespace USAGE; keep table access revoked.
GRANT USAGE ON SCHEMA private TO agsaas_app, service_role;
GRANT EXECUTE ON FUNCTION private.reconcile_storage_documents(integer) TO agsaas_app, service_role;
NOTIFY pgrst, 'reload schema';
