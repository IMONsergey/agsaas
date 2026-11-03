-- Forward-only receipt erasure identity. Existing migration files remain unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE private.inbox_deletion_receipts (
  team_id uuid NOT NULL,
  reference_hash text NOT NULL CHECK (reference_hash ~ '^[a-f0-9]{64}$'),
  inbox_id uuid NOT NULL,
  object_hash text CHECK (object_hash ~ '^[a-f0-9]{64}$'),
  content_type_hash text CHECK (content_type_hash ~ '^[a-f0-9]{64}$'),
  byte_size bigint,
  content_sha256 text CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_sha256 text CHECK (metadata_sha256 ~ '^[a-f0-9]{64}$'),
  digest_failure text CHECK (digest_failure IN ('download_unavailable','size_unverifiable','team_deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (content_sha256 IS NULL OR digest_failure IS NULL),
  PRIMARY KEY (team_id, reference_hash)
);
CREATE INDEX inbox_deletion_receipts_object_idx
  ON private.inbox_deletion_receipts(team_id, object_hash);
ALTER TABLE private.inbox_deletion_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY backend_read ON private.inbox_deletion_receipts FOR SELECT
  TO agsaas_app, service_role USING (true);
REVOKE ALL ON private.inbox_deletion_receipts FROM PUBLIC, anon, authenticated, agsaas_app, service_role;
GRANT SELECT ON private.inbox_deletion_receipts TO agsaas_app, service_role;
COMMENT ON TABLE private.inbox_deletion_receipts IS
  'Erasure evidence only: UUIDs, digests, original byte size and bounded failure codes. No raw source reference/path/name/sender/subject/extracted content. Not an Inbox item or quota usage.';

CREATE FUNCTION private.inbox_webhook_metadata_digest(p_meta jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $fn$
  SELECT CASE WHEN p_meta->>'source' = 'postmark'
    AND p_meta->>'sourceVersion' = 'postmark-inbound-v1'
    AND p_meta->>'contentSha256' ~ '^[a-f0-9]{64}$'
  THEN encode(sha256(convert_to(jsonb_build_object(
    'source',p_meta->'source', 'sourceVersion',p_meta->'sourceVersion',
    'messageId',p_meta->'messageId', 'attachmentIndex',p_meta->'attachmentIndex',
    'attachmentContentId',p_meta->'attachmentContentId',
    'originalFileName',p_meta->'originalFileName',
    'contentSha256',p_meta->'contentSha256'
  )::text,'UTF8')),'hex') END;
$fn$;
REVOKE ALL ON FUNCTION private.inbox_webhook_metadata_digest(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.inbox_webhook_metadata_digest(jsonb) TO agsaas_app, service_role;

-- Application writers acquire this before their row locks. Row triggers use
-- nonblocking acquisition: they may already own a tuple lock and must refuse a
-- conflicting order instead of waiting in a row/advisory deadlock.
-- Team KEY SHARE precedes reference and object advisory locks. Team deletion
-- therefore finishes before a new scope starts, or waits until that scope ends.
CREATE FUNCTION private.lock_inbox_deletion_scope(
  p_team uuid, p_reference_hash text, p_object_hash text,
  p_try boolean DEFAULT false, p_allow_missing_team boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE lock_key bigint;
BEGIN
  IF p_team IS NULL THEN RAISE EXCEPTION 'Missing receipt team' USING ERRCODE='23514'; END IF;
  -- A transaction-wide old snapshot could miss a committed erasure marker.
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'Receipt lifecycle writes require a fresh command snapshot' USING ERRCODE='40001';
  END IF;
  IF p_try THEN
    PERFORM id FROM public.teams WHERE id=p_team FOR KEY SHARE NOWAIT;
  ELSE
    PERFORM id FROM public.teams WHERE id=p_team FOR KEY SHARE;
  END IF;
  IF NOT FOUND AND NOT p_allow_missing_team THEN
    RAISE EXCEPTION 'Receipt team is no longer active' USING ERRCODE='23514';
  END IF;
  IF p_reference_hash IS NOT NULL THEN
    IF p_reference_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid reference digest' USING ERRCODE='23514'; END IF;
    lock_key := hashtextextended('agsaas.inbox.reference:' || p_team::text || ':' || p_reference_hash,0);
    IF p_try THEN
      IF NOT pg_try_advisory_xact_lock(lock_key) THEN RAISE EXCEPTION 'Receipt scope is busy; retry transaction' USING ERRCODE='40001'; END IF;
    ELSE PERFORM pg_advisory_xact_lock(lock_key); END IF;
  END IF;
  IF p_object_hash IS NOT NULL THEN
    IF p_object_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid object digest' USING ERRCODE='23514'; END IF;
    lock_key := hashtextextended('agsaas.vault.object:' || p_team::text || ':' || p_object_hash,0);
    IF p_try THEN
      IF NOT pg_try_advisory_xact_lock(lock_key) THEN RAISE EXCEPTION 'Object scope is busy; retry transaction' USING ERRCODE='40001'; END IF;
    ELSE PERFORM pg_advisory_xact_lock(lock_key); END IF;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION private.lock_inbox_deletion_scope(uuid,text,text,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.lock_inbox_deletion_scope(uuid,text,text,boolean,boolean) TO agsaas_app, service_role;

CREATE FUNCTION private.guard_inbox_deletion_receipt() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE scope_team uuid; scope_reference text; scope_path text[];
  reference_digest text; object_digest text; metadata_digest text;
BEGIN
  IF TG_OP='DELETE' THEN
    scope_team:=OLD.team_id; scope_reference:=OLD.reference_id; scope_path:=OLD.file_path;
  ELSE
    scope_team:=NEW.team_id; scope_reference:=NEW.reference_id; scope_path:=NEW.file_path;
  END IF;
  IF scope_team IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Inbox receipt requires its team' USING ERRCODE='23514';
  END IF;
  reference_digest:=CASE WHEN scope_reference IS NOT NULL THEN encode(sha256(convert_to(scope_reference,'UTF8')),'hex') END;
  object_digest:=CASE WHEN cardinality(scope_path)>0 THEN encode(sha256(convert_to('vault:' || array_to_string(scope_path,'/'),'UTF8')),'hex') END;
  -- Baseline permits non-file receipts and existing legacy NULL paths. New
  -- canonical webhook rows require a path; any supplied new path is scoped.
  -- Unchanged legacy identity remains updatable and erasable after this upgrade.
  IF TG_OP='INSERT' AND (
    (scope_path IS NULL AND private.inbox_webhook_metadata_digest(NEW.meta::jsonb) IS NOT NULL)
    OR (scope_path IS NOT NULL AND (
      cardinality(scope_path)<2 OR scope_path[1] IS DISTINCT FROM scope_team::text
      OR EXISTS(SELECT 1 FROM unnest(scope_path) AS part WHERE part IS NULL OR part IN ('','.','..') OR part ~ '[/\\\\%?#]')
    ))
  ) THEN RAISE EXCEPTION 'Inbox object is outside its team' USING ERRCODE='23514'; END IF;
  PERFORM private.lock_inbox_deletion_scope(scope_team,reference_digest,object_digest,true,TG_OP='DELETE');
  IF TG_OP='DELETE' THEN
    metadata_digest:=private.inbox_webhook_metadata_digest(OLD.meta::jsonb);
    IF reference_digest IS NOT NULL THEN
      INSERT INTO private.inbox_deletion_receipts(
        team_id,reference_hash,inbox_id,object_hash,content_type_hash,byte_size,
        content_sha256,metadata_sha256,digest_failure
      ) VALUES (
        scope_team,reference_digest,OLD.id,object_digest,CASE WHEN OLD.content_type IS NOT NULL THEN encode(sha256(convert_to(OLD.content_type,'UTF8')),'hex') END,OLD.size,
        CASE WHEN metadata_digest IS NOT NULL THEN OLD.meta->>'contentSha256' END,
        metadata_digest,
        CASE WHEN metadata_digest IS NULL AND NOT EXISTS(SELECT 1 FROM public.teams WHERE id=scope_team) THEN 'team_deleted' END
      ) ON CONFLICT DO NOTHING;
    END IF;
    IF object_digest IS NOT NULL THEN
      INSERT INTO public.storage_deletion_tombstones(team_id,object_hash)
        VALUES(scope_team,object_digest) ON CONFLICT DO NOTHING;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.team_id,NEW.reference_id,NEW.file_path)
      IS DISTINCT FROM ROW(OLD.team_id,OLD.reference_id,OLD.file_path) THEN
    RAISE EXCEPTION 'Inbox receipt identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND private.inbox_webhook_metadata_digest(OLD.meta::jsonb) IS NOT NULL
    AND ROW(NEW.content_type,NEW.size,private.inbox_webhook_metadata_digest(NEW.meta::jsonb))
      IS DISTINCT FROM ROW(OLD.content_type,OLD.size,private.inbox_webhook_metadata_digest(OLD.meta::jsonb))
  THEN RAISE EXCEPTION 'Webhook receipt evidence is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.status='deleted' THEN
    RAISE EXCEPTION 'Use the Inbox erasure command' USING ERRCODE='23514';
  END IF;
  IF (reference_digest IS NOT NULL AND EXISTS(
      SELECT 1 FROM private.inbox_deletion_receipts WHERE team_id=scope_team AND reference_hash=reference_digest))
    OR (object_digest IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.storage_deletion_tombstones WHERE team_id=scope_team AND object_hash=object_digest))
    OR (TG_OP='UPDATE' AND OLD.status='deleted') THEN
    IF TG_OP='UPDATE' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'Inbox receipt was deleted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION private.guard_inbox_deletion_receipt() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_inbox_deletion_receipt BEFORE INSERT OR UPDATE OR DELETE ON public.inbox
  FOR EACH ROW EXECUTE FUNCTION private.guard_inbox_deletion_receipt();

CREATE FUNCTION private.guard_storage_deletion_scope() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Storage erasure markers are immutable' USING ERRCODE='23514';
  END IF;
  PERFORM private.lock_inbox_deletion_scope(NEW.team_id,NULL,NEW.object_hash,true,true);
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION private.guard_storage_deletion_scope() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_storage_deletion_scope BEFORE INSERT ON public.storage_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION private.guard_storage_deletion_scope();

CREATE OR REPLACE FUNCTION private.guard_live_storage_object() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE scoped_id uuid; part text; object_digest text;
BEGIN
  IF NEW.bucket_id='vault' OR NEW.bucket_id='apps' THEN
    part:=split_part(NEW.name,'/',1);
    IF part !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid team storage namespace' USING ERRCODE='23514';
    END IF;
    scoped_id:=part::uuid;
    IF NEW.bucket_id='vault' THEN
      object_digest:=encode(sha256(convert_to('vault:' || NEW.name,'UTF8')),'hex');
      PERFORM private.lock_inbox_deletion_scope(scoped_id,NULL,object_digest,true,false);
    ELSE
      PERFORM id FROM public.teams WHERE id=scoped_id FOR KEY SHARE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'Storage team is no longer active' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF NEW.bucket_id='avatars' AND NEW.name LIKE 'teams/%' THEN
    scoped_id:=split_part(NEW.name,'/',2)::uuid;
    PERFORM id FROM public.teams WHERE id=scoped_id FOR KEY SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Storage team is no longer active' USING ERRCODE='23514'; END IF;
  ELSIF NEW.bucket_id='avatars' AND NEW.name LIKE 'users/%' THEN
    scoped_id:=split_part(NEW.name,'/',2)::uuid;
    PERFORM id FROM public.users WHERE id=scoped_id AND deletion_started_at IS NULL FOR KEY SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Storage user is no longer active' USING ERRCODE='23514'; END IF;
  ELSIF NEW.bucket_id='avatars' AND TG_OP='INSERT' THEN
    RAISE EXCEPTION 'Invalid avatar storage namespace' USING ERRCODE='23514';
  END IF;
  IF NEW.bucket_id='vault' AND EXISTS(
    SELECT 1 FROM public.storage_deletion_tombstones WHERE team_id=scoped_id AND object_hash=object_digest
  ) THEN RAISE EXCEPTION 'This object is pending deletion' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION private.guard_deleted_document() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE object_digest text;
BEGIN
  object_digest:=encode(sha256(convert_to('vault:' || array_to_string(NEW.path_tokens,'/'),'UTF8')),'hex');
  PERFORM private.lock_inbox_deletion_scope(NEW.team_id,NULL,object_digest,true,true);
  IF NOT EXISTS(SELECT 1 FROM public.teams WHERE id=NEW.team_id)
    OR EXISTS(SELECT 1 FROM public.storage_deletion_tombstones WHERE team_id=NEW.team_id AND object_hash=object_digest)
  THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION private.guard_inbox_deletion_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Inbox deletion evidence is retained' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.team_id,NEW.reference_hash,NEW.inbox_id,NEW.object_hash,NEW.content_type_hash,NEW.byte_size,NEW.metadata_sha256,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.team_id,OLD.reference_hash,OLD.inbox_id,OLD.object_hash,OLD.content_type_hash,OLD.byte_size,OLD.metadata_sha256,OLD.created_at)
    OR (OLD.content_sha256 IS NOT NULL AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
  THEN RAISE EXCEPTION 'Inbox deletion evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION private.guard_inbox_deletion_proof() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_inbox_deletion_proof BEFORE UPDATE ON private.inbox_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION private.guard_inbox_deletion_proof();

-- Only the active cleanup lease may retain a digest read from its encrypted
-- target. A read failure records uncertainty and must not prevent byte erasure.
CREATE FUNCTION private.retain_inbox_deletion_digest(
  p_cleanup uuid,p_token uuid,p_digest text,p_size bigint,p_failure text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE cleanup public.resource_cleanups%ROWTYPE;
BEGIN
  IF (p_digest IS NOT NULL AND (p_digest !~ '^[a-f0-9]{64}$' OR p_size IS NULL OR p_size<1 OR p_size>52428800 OR p_failure IS NOT NULL))
    OR (p_digest IS NULL AND (p_size IS NOT NULL OR p_failure IS NULL OR p_failure NOT IN ('download_unavailable','size_unverifiable'))) THEN
    RAISE EXCEPTION 'Invalid deletion digest observation' USING ERRCODE='23514';
  END IF;
  SELECT * INTO cleanup FROM public.resource_cleanups
    WHERE id=p_cleanup AND dispatch_token=p_token AND status='processing'
      AND lease_expires_at>clock_timestamp() AND kind='storage-object'
    FOR UPDATE;
  IF NOT FOUND OR cleanup.lease_expires_at IS NULL
    OR cleanup.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  -- The initial predicate may have run before waiting for an unchanged tuple.
  -- Recheck wall clock while owning its lock before recording any observation.
  UPDATE private.inbox_deletion_receipts SET
    content_sha256=CASE WHEN p_digest IS NOT NULL AND byte_size=p_size THEN p_digest END,
    digest_failure=CASE WHEN p_digest IS NOT NULL AND byte_size=p_size THEN NULL
      WHEN p_digest IS NOT NULL THEN 'size_unverifiable' ELSE p_failure END
  WHERE team_id=cleanup.team_id AND object_hash=cleanup.target_id AND content_sha256 IS NULL;
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION private.retain_inbox_deletion_digest(uuid,uuid,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.retain_inbox_deletion_digest(uuid,uuid,text,bigint,text) TO agsaas_app, service_role;
