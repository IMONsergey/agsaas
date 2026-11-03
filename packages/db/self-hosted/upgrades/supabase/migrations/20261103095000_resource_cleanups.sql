SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE public.resource_cleanups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('provider','storage-object','storage-team','storage-user','auth-user','marketing','billing','retention')),
  team_id uuid,
  actor_user_id uuid,
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  provider text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','unknown','manual_required','failed')),
  encrypted_payload text CHECK (octet_length(encrypted_payload) <= 100000),
  unique_key text NOT NULL,
  grant_key text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason text CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  evidence_reference text,
  dispatch_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_id IS NOT NULL OR actor_user_id IS NOT NULL),
  CHECK ((status = 'processing') = (dispatch_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'completed' OR encrypted_payload IS NULL)
);
CREATE UNIQUE INDEX resource_cleanups_active_unique ON public.resource_cleanups(unique_key) WHERE status <> 'completed';
CREATE INDEX resource_cleanups_due_idx ON public.resource_cleanups(next_attempt_at) WHERE status = 'pending';
CREATE INDEX resource_cleanups_grant_idx ON public.resource_cleanups(grant_key) WHERE status <> 'completed';
CREATE INDEX resource_cleanups_team_idx ON public.resource_cleanups(team_id, created_at DESC);
CREATE INDEX resource_cleanups_actor_idx ON public.resource_cleanups(actor_user_id, created_at DESC);
ALTER TABLE public.resource_cleanups ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.resource_cleanups TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.resource_cleanups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.resource_cleanups TO agsaas_app, service_role;
COMMENT ON TABLE public.resource_cleanups IS 'Durable deletion/revocation ledger. Retained encrypted targets survive parent deletion. Unknown and manual work must not be reported as completed. Backups/billing/legacy unscoped assets require recorded operational evidence.';

CREATE TABLE public.storage_deletion_tombstones (
  team_id uuid NOT NULL,
  object_hash text NOT NULL CHECK (object_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, object_hash)
);
ALTER TABLE public.storage_deletion_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY agsaas_backend ON public.storage_deletion_tombstones TO agsaas_app USING (true) WITH CHECK (true);
REVOKE ALL ON public.storage_deletion_tombstones FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.storage_deletion_tombstones TO agsaas_app, service_role;

-- Serialized with team/profile deletion even for service-role writes bypassing RLS.
CREATE FUNCTION private.guard_live_storage_object() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE scoped_id uuid; part text; valid boolean;
BEGIN
  IF NEW.bucket_id = 'vault' OR NEW.bucket_id = 'apps' THEN
    part := split_part(NEW.name, '/', 1);
    IF part !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid team storage namespace' USING ERRCODE = '23514'; END IF;
    scoped_id := part::uuid;
    PERFORM id FROM public.teams WHERE id = scoped_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Storage team is no longer active' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.bucket_id = 'avatars' AND NEW.name LIKE 'teams/%' THEN
    scoped_id := split_part(NEW.name, '/', 2)::uuid;
    PERFORM id FROM public.teams WHERE id = scoped_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Storage team is no longer active' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.bucket_id = 'avatars' AND NEW.name LIKE 'users/%' THEN
    scoped_id := split_part(NEW.name, '/', 2)::uuid;
    PERFORM id FROM public.users WHERE id = scoped_id AND deletion_started_at IS NULL FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Storage user is no longer active' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.bucket_id = 'avatars' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Invalid avatar storage namespace' USING ERRCODE = '23514';
  END IF;
  IF NEW.bucket_id = 'vault' AND EXISTS (SELECT 1 FROM public.storage_deletion_tombstones t WHERE t.team_id = scoped_id AND t.object_hash = encode(sha256(convert_to('vault:' || NEW.name, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'This object is pending deletion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_live_storage_object() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_live_storage_object BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION private.guard_live_storage_object();

CREATE FUNCTION private.guard_deleted_document() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.storage_deletion_tombstones t WHERE t.team_id = NEW.team_id AND t.object_hash = encode(sha256(convert_to('vault:' || array_to_string(NEW.path_tokens, '/'), 'UTF8')), 'hex')) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_deleted_document() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_deleted_document BEFORE INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION private.guard_deleted_document();

-- Only an actively claimed, server-retained scope can enumerate deletion targets.
CREATE FUNCTION private.cleanup_storage_batch(p_id uuid, p_token uuid) RETURNS TABLE(bucket text, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.bucket_id, o.name FROM storage.objects o JOIN public.resource_cleanups c ON c.id = p_id
  WHERE c.status = 'processing' AND c.dispatch_token = p_token AND c.lease_expires_at > now()
    AND ((c.kind = 'storage-team' AND c.target_id = c.team_id::text AND (
      (o.bucket_id = 'vault' AND starts_with(o.name, c.team_id::text || '/')) OR
      (o.bucket_id = 'apps' AND starts_with(o.name, c.team_id::text || '/')) OR
      (o.bucket_id = 'avatars' AND starts_with(o.name, 'teams/' || c.team_id::text || '/')))) OR
      (c.kind = 'storage-user' AND c.target_id = c.actor_user_id::text AND o.bucket_id = 'avatars' AND starts_with(o.name, 'users/' || c.actor_user_id::text || '/')))
  ORDER BY o.bucket_id, o.name LIMIT 100;
$$;
REVOKE ALL ON FUNCTION private.cleanup_storage_batch(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.cleanup_storage_batch(uuid, uuid) TO agsaas_app, service_role;
CREATE FUNCTION private.cleanup_storage_object_exists(p_id uuid, p_token uuid, p_path text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM storage.objects o JOIN public.resource_cleanups c ON c.id = p_id
    WHERE c.status = 'processing' AND c.dispatch_token = p_token AND c.lease_expires_at > now() AND c.kind = 'storage-object'
      AND c.target_id = encode(sha256(convert_to('vault:' || p_path, 'UTF8')), 'hex')
      AND split_part(p_path, '/', 1) = c.team_id::text AND o.bucket_id = 'vault' AND o.name = p_path);
$$;
REVOKE ALL ON FUNCTION private.cleanup_storage_object_exists(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.cleanup_storage_object_exists(uuid, uuid, text) TO agsaas_app, service_role;

-- Support INSERT grants intentionally do not include DELETE. Keep erasure scoped
-- behind a private backend-only function; never grant broad browser deletion.
CREATE FUNCTION private.purge_support_subject(p_team uuid, p_user uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE removed bigint;
BEGIN
  IF (p_team IS NULL) = (p_user IS NULL) THEN RAISE EXCEPTION 'Exactly one erasure subject is required'; END IF;
  DELETE FROM public.support_requests WHERE (p_team IS NOT NULL AND team_id = p_team) OR (p_user IS NOT NULL AND user_id = p_user);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION private.purge_support_subject(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.purge_support_subject(uuid, uuid) TO agsaas_app, service_role;
