-- CODE-12. Existing rows remain readable/exportable; only new allocations are limited.
CREATE TABLE public.team_quota_usage (
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('inbox','invoices')),
  resource_id uuid NOT NULL,
  period date NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL DEFAULT 'admission' CHECK(source IN ('admission','legacy_baseline')),
  PRIMARY KEY(kind,resource_id)
);
CREATE INDEX team_quota_usage_period_idx ON public.team_quota_usage(team_id,period,kind);
CREATE TABLE public.team_connector_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  toolkit text NOT NULL CHECK(toolkit ~ '^[a-z0-9_-]{1,100}$'),
  entity_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disconnecting','unknown','released')),
  provider_account_id text,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(entity_id='agsaas-team-'||team_id::text),
  CHECK(provider_account_id IS NULL OR length(provider_account_id) BETWEEN 1 AND 256)
);
CREATE UNIQUE INDEX team_connector_active_toolkit_unique ON public.team_connector_reservations(team_id,toolkit) WHERE status<>'released';
CREATE UNIQUE INDEX team_connector_provider_account_unique ON public.team_connector_reservations(provider_account_id) WHERE provider_account_id IS NOT NULL;
CREATE TABLE public.generated_storage_grants (
  bucket_id text NOT NULL CHECK(bucket_id='vault'),
  name text NOT NULL,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK(source_kind IN ('invoice','export')),
  source_id uuid NOT NULL,
  bytes bigint NOT NULL CHECK(bytes>=0 AND bytes<=9007199254740991),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(bucket_id,name)
);
ALTER TABLE public.team_quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_connector_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_storage_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_quota_usage,public.team_connector_reservations,public.generated_storage_grants FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.team_quota_usage TO agsaas_app;
GRANT SELECT,INSERT,UPDATE ON public.team_connector_reservations TO agsaas_app;
GRANT SELECT ON public.generated_storage_grants TO agsaas_app;
CREATE POLICY quota_backend ON public.team_quota_usage FOR SELECT TO agsaas_app USING(true);
CREATE POLICY connector_quota_backend ON public.team_connector_reservations TO agsaas_app USING(true) WITH CHECK(true);
CREATE POLICY generated_storage_backend ON public.generated_storage_grants FOR SELECT TO agsaas_app USING(true);

CREATE FUNCTION public.agsaas_quota_lock(p_team uuid) RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('agsaas-quota:'||p_team::text,0));
$$;
CREATE FUNCTION public.agsaas_plan_limits(p_plan text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE p_plan
 WHEN 'starter' THEN jsonb_build_object('users',2,'bankConnections',3,'connectors',5,'storage',10737418240::bigint,'inbox',150,'invoices',15)
 WHEN 'pro' THEN jsonb_build_object('users',10,'bankConnections',10,'connectors',20,'storage',107374182400::bigint,'inbox',500,'invoices',50)
 WHEN 'trial' THEN jsonb_build_object('users',10,'bankConnections',10,'connectors',20,'storage',107374182400::bigint,'inbox',500,'invoices',50)
 ELSE jsonb_build_object('users',1,'bankConnections',1,'connectors',2,'storage',1073741824::bigint,'inbox',50,'invoices',5) END;
$$;
CREATE FUNCTION public.agsaas_team_entitlement(p_team uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.teams; effective text; period_start date; trial_end timestamptz;
BEGIN
 SELECT * INTO t FROM public.teams WHERE id=p_team;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found'; END IF;
 trial_end:=t.created_at+interval '14 days';
 effective:=t.plan::text;
 IF t.plan='trial' AND (clock_timestamp()>=trial_end OR t.billing_subscription_id IS NOT NULL OR t.canceled_at IS NOT NULL) THEN effective:='free'; END IF;
 IF t.plan<>'trial' AND t.billing_subscription_id IS NOT NULL AND t.subscription_status IS NULL THEN effective:='free'; END IF;
 period_start:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
 RETURN jsonb_build_object('effectivePlan',effective,'pastDue',t.subscription_status='past_due','trialEndsAt',CASE WHEN t.plan='trial' THEN trial_end END,
  'period',period_start,'resetsAt',(period_start+interval '1 month') AT TIME ZONE 'UTC','limits',public.agsaas_plan_limits(effective));
END $$;
CREATE FUNCTION public.agsaas_assert_quota(p_team uuid,p_resource text,p_used bigint,p_previous bigint) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ent jsonb; cap bigint;
BEGIN
 IF p_used<=p_previous THEN RETURN; END IF;
 PERFORM public.agsaas_quota_lock(p_team);
 ent:=public.agsaas_team_entitlement(p_team); cap:=(ent->'limits'->>p_resource)::bigint;
 IF cap IS NULL THEN RAISE EXCEPTION 'Unknown quota resource'; END IF;
 IF coalesce((ent->>'pastDue')::boolean,false) OR p_used>cap THEN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE=CASE WHEN coalesce((ent->>'pastDue')::boolean,false) THEN 'AGSAAS_PLAN_PAST_DUE' ELSE 'AGSAAS_QUOTA_EXCEEDED' END,
   DETAIL=jsonb_build_object('resource',p_resource,'used',p_used,'limit',cap,'resetsAt',ent->>'resetsAt')::text;
 END IF;
END $$;
CREATE FUNCTION public.agsaas_protect_entitlements() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM public.agsaas_quota_lock(NEW.id); END IF;
 IF current_user IN ('authenticated','anon') THEN
  IF TG_OP='INSERT' THEN
   IF NEW.plan::text<>'trial' OR NEW.subscription_status IS NOT NULL OR NEW.billing_subscription_id IS NOT NULL OR NEW.billing_subscription_created_at IS NOT NULL OR NEW.billing_updated_at IS NOT NULL OR NEW.canceled_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AGSAAS_ENTITLEMENT_WRITE_FORBIDDEN';
   END IF;
   NEW.created_at:=clock_timestamp();
  ELSIF ROW(NEW.plan,NEW.subscription_status,NEW.billing_subscription_id,NEW.billing_subscription_created_at,NEW.billing_updated_at,NEW.canceled_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.plan,OLD.subscription_status,OLD.billing_subscription_id,OLD.billing_subscription_created_at,OLD.billing_updated_at,OLD.canceled_at,OLD.created_at) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AGSAAS_ENTITLEMENT_WRITE_FORBIDDEN';
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- The lock function is intentionally callable from this invoker trigger by authenticated users; it performs no data read/write.
REVOKE ALL ON FUNCTION public.agsaas_quota_lock(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.agsaas_quota_lock(uuid) TO authenticated,agsaas_app;
CREATE TRIGGER a_agsaas_team_entitlements BEFORE INSERT OR UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.agsaas_protect_entitlements();
CREATE FUNCTION public.agsaas_quota_usage_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Monthly quota evidence is immutable';
END $$;
CREATE TRIGGER quota_usage_immutable BEFORE UPDATE OR DELETE ON public.team_quota_usage FOR EACH ROW EXECUTE FUNCTION public.agsaas_quota_usage_immutable();

-- Preserve existing identity/usage evidence. Legacy timestamps are a stated baseline, not reconstructed deleted history.
INSERT INTO public.team_quota_usage(team_id,kind,resource_id,period,used_at,source)
 SELECT team_id,'inbox',id,date_trunc('month',least(coalesce(created_at,clock_timestamp()),clock_timestamp()) AT TIME ZONE 'UTC')::date,
 coalesce(created_at,clock_timestamp()),'legacy_baseline' FROM public.inbox WHERE team_id IS NOT NULL;
INSERT INTO public.team_quota_usage(team_id,kind,resource_id,period,used_at,source)
 SELECT team_id,'invoices',id,date_trunc('month',least(coalesce(sent_at,created_at,clock_timestamp()),clock_timestamp()) AT TIME ZONE 'UTC')::date,
 coalesce(sent_at,created_at,clock_timestamp()),'legacy_baseline' FROM public.invoices
 WHERE status IN ('unpaid','overdue','paid','refunded') OR document_snapshot IS NOT NULL OR sent_at IS NOT NULL;

CREATE FUNCTION public.agsaas_resource_quota() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid; resource text; used bigint; now_month date; old_json jsonb; new_json jsonb;
BEGIN
 new_json:=to_jsonb(NEW); old_json:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 t:=(new_json->>'team_id')::uuid;
 IF t IS NULL THEN RAISE EXCEPTION 'A quota resource requires its team'; END IF;
 IF TG_OP='UPDATE' AND (new_json->>'team_id' IS DISTINCT FROM old_json->>'team_id' OR new_json->>'id' IS DISTINCT FROM old_json->>'id') THEN RAISE EXCEPTION 'Quota resource identity cannot be moved'; END IF;
 PERFORM public.agsaas_quota_lock(t);
 IF TG_TABLE_NAME='users_on_team' THEN
  IF TG_OP='UPDATE' AND NEW.user_id=OLD.user_id THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM public.users_on_team WHERE team_id=t AND user_id=NEW.user_id AND id<>NEW.id) THEN RETURN NULL; END IF;
  SELECT count(distinct user_id) INTO used FROM public.users_on_team WHERE team_id=t;
  PERFORM public.agsaas_assert_quota(t,'users',used,used-1);
 ELSIF TG_TABLE_NAME='bank_connections' THEN
  IF TG_OP='UPDATE' THEN RETURN NULL; END IF;
  SELECT (SELECT count(*) FROM public.bank_connections WHERE team_id=t)+
   (SELECT count(*) FROM public.bank_connection_cleanups c WHERE c.team_id=t AND c.status<>'completed' AND NOT EXISTS(SELECT 1 FROM public.bank_connections b WHERE b.id=c.connection_id)) INTO used;
  PERFORM public.agsaas_assert_quota(t,'bankConnections',used,used-1);
 ELSIF TG_TABLE_NAME='team_connector_reservations' THEN
  IF TG_OP='UPDATE' THEN
   IF NEW.toolkit<>OLD.toolkit OR NEW.entity_id<>OLD.entity_id OR (OLD.provider_account_id IS NOT NULL AND NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id) THEN RAISE EXCEPTION 'Connector reservation binding is immutable'; END IF;
   IF OLD.status='released' AND NEW.status<>'released' THEN RAISE EXCEPTION 'Released connector reservation cannot be revived'; END IF;
   IF OLD.status='disconnecting' AND NEW.status NOT IN ('disconnecting','released') THEN RAISE EXCEPTION 'Disconnecting connector cannot be reactivated'; END IF;
   IF OLD.status<>'released' THEN RETURN NULL; END IF;
  END IF;
  IF NEW.status='released' THEN RETURN NULL; END IF;
  SELECT count(*) INTO used FROM public.team_connector_reservations WHERE team_id=t AND status<>'released';
  PERFORM public.agsaas_assert_quota(t,'connectors',used,used-1);
 ELSE
  resource:=CASE WHEN TG_TABLE_NAME='inbox' THEN 'inbox' ELSE 'invoices' END;
  IF EXISTS(SELECT 1 FROM public.team_quota_usage WHERE kind=resource AND resource_id=NEW.id) THEN
   IF TG_OP='INSERT' THEN RAISE EXCEPTION 'A previously used resource identity cannot be recreated'; END IF;
   RETURN NULL;
  END IF;
  IF resource='inbox' AND TG_OP<>'INSERT' THEN RETURN NULL; END IF;
  IF resource='invoices' THEN
   IF NOT(new_json->>'status' IN ('unpaid','overdue','paid','refunded') OR coalesce(new_json->'document_snapshot'<>'null'::jsonb,false) OR new_json->>'sent_at' IS NOT NULL) THEN RETURN NULL; END IF;
  END IF;
  now_month:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
  SELECT count(*) INTO used FROM public.team_quota_usage WHERE team_id=t AND kind=resource AND period=now_month;
  PERFORM public.agsaas_assert_quota(t,resource,used+1,used);
  INSERT INTO public.team_quota_usage(team_id,kind,resource_id,period) VALUES(t,resource,NEW.id,now_month);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zz_team_quota AFTER INSERT OR UPDATE ON public.users_on_team FOR EACH ROW EXECUTE FUNCTION public.agsaas_resource_quota();
CREATE TRIGGER zz_team_quota AFTER INSERT OR UPDATE ON public.bank_connections FOR EACH ROW EXECUTE FUNCTION public.agsaas_resource_quota();
CREATE TRIGGER zz_team_quota AFTER INSERT OR UPDATE ON public.inbox FOR EACH ROW EXECUTE FUNCTION public.agsaas_resource_quota();
CREATE TRIGGER zz_team_quota AFTER INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.agsaas_resource_quota();
CREATE TRIGGER zz_team_quota AFTER INSERT OR UPDATE ON public.team_connector_reservations FOR EACH ROW EXECUTE FUNCTION public.agsaas_resource_quota();

CREATE FUNCTION public.agsaas_storage_team(p_bucket text,p_name text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE candidate text;
BEGIN
 candidate:=CASE WHEN p_bucket IN ('vault','apps') THEN split_part(p_name,'/',1)
   WHEN p_bucket='avatars' AND split_part(p_name,'/',1)='teams' THEN split_part(p_name,'/',2) END;
 IF candidate ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN candidate::uuid; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.agsaas_storage_size(p_row jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN coalesce((p_row->>'is_delete_marker')::boolean,false) THEN 0
 WHEN p_row->'metadata'->>'size' ~ '^[0-9]{1,15}$' THEN (p_row->'metadata'->>'size')::bigint END;
$$;
CREATE FUNCTION public.reserve_generated_storage(p_team uuid,p_name text,p_kind text,p_source uuid,p_bytes bigint) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op text;
BEGIN
 IF p_bytes<0 OR p_bytes>9007199254740991 THEN RAISE EXCEPTION 'Invalid generated object size'; END IF;
 IF p_kind='invoice' THEN
  IF p_name<>p_team::text||'/invoices/'||p_source::text||'.pdf' OR NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=p_source AND i.team_id=p_team AND i.document_snapshot IS NOT NULL) OR
   NOT EXISTS(SELECT 1 FROM public.financial_job_dispatches j WHERE j.team_id=p_team AND j.job_name='generate-invoice' AND j.payload->>'invoiceId'=p_source::text) THEN RAISE EXCEPTION 'Generated invoice object lacks its immutable document and authorized intent'; END IF;
 ELSIF p_kind='export' THEN
  SELECT operation_key INTO op FROM public.export_snapshots WHERE id=p_source AND team_id=p_team;
  IF op IS NULL OR p_name !~ ('^'||p_team::text||'/exports/'||op||'/[a-f0-9]{64}\.zip$') THEN RAISE EXCEPTION 'Generated export object does not match its immutable snapshot'; END IF;
 ELSE RAISE EXCEPTION 'Unknown generated object purpose'; END IF;
 INSERT INTO public.generated_storage_grants(bucket_id,name,team_id,source_kind,source_id,bytes,expires_at)
 VALUES('vault',p_name,p_team,p_kind,p_source,p_bytes,clock_timestamp()+interval '1 hour')
 ON CONFLICT(bucket_id,name) DO UPDATE SET bytes=excluded.bytes,expires_at=excluded.expires_at
 WHERE generated_storage_grants.team_id=excluded.team_id AND generated_storage_grants.source_kind=excluded.source_kind AND generated_storage_grants.source_id=excluded.source_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Generated object reservation identity conflict'; END IF;
END $$;
CREATE FUNCTION public.agsaas_storage_quota() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,storage AS $$
DECLARE t uuid; old_t uuid; size_new bigint; size_old bigint; used bigint; trusted boolean; claims jsonb;
BEGIN
 t:=public.agsaas_storage_team(NEW.bucket_id,NEW.name);
 IF t IS NULL THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' THEN old_t:=public.agsaas_storage_team(OLD.bucket_id,OLD.name); IF old_t IS DISTINCT FROM t THEN RAISE EXCEPTION 'Team storage cannot be moved between quotas'; END IF; END IF;
 PERFORM public.agsaas_quota_lock(t);
 size_new:=public.agsaas_storage_size(to_jsonb(NEW));
 size_old:=CASE WHEN TG_OP='UPDATE' THEN coalesce(public.agsaas_storage_size(to_jsonb(OLD)),0) ELSE 0 END;
 -- Storage permission probes contain contentLength, not the final size, and roll back their savepoint.
 IF size_new IS NULL THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND size_new<=size_old THEN RETURN NULL; END IF;
 claims:=coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
 -- A browser role cannot gain the exception by setting a JWT-shaped SQL setting.
 trusted:=((claims->>'role'='service_role') AND coalesce(current_setting('role',true),'none') NOT IN ('authenticated','anon') AND session_user NOT IN ('authenticated','anon')) OR session_user='agsaas_app';
 IF trusted AND EXISTS(SELECT 1 FROM public.generated_storage_grants g WHERE g.bucket_id=NEW.bucket_id AND g.name=NEW.name AND g.team_id=t AND g.bytes=size_new AND g.expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM storage.objects o WHERE public.agsaas_storage_team(o.bucket_id,o.name)=t AND public.agsaas_storage_size(to_jsonb(o)) IS NULL) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AGSAAS_QUOTA_METADATA_REQUIRED'; END IF;
 SELECT coalesce(sum(public.agsaas_storage_size(to_jsonb(o))),0) INTO used FROM storage.objects o WHERE public.agsaas_storage_team(o.bucket_id,o.name)=t;
 PERFORM public.agsaas_assert_quota(t,'storage',used,used-size_new+size_old);
 RETURN NULL;
END $$;
CREATE FUNCTION public.agsaas_storage_metadata_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,storage AS $$
DECLARE current_row jsonb;
BEGIN
 SELECT to_jsonb(o) INTO current_row FROM storage.objects o WHERE id=NEW.id;
 IF current_row IS NOT NULL AND public.agsaas_storage_team(current_row->>'bucket_id',current_row->>'name') IS NOT NULL AND public.agsaas_storage_size(current_row) IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AGSAAS_QUOTA_METADATA_REQUIRED';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zz_agsaas_storage_quota AFTER INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.agsaas_storage_quota();
CREATE CONSTRAINT TRIGGER zz_agsaas_storage_metadata_commit AFTER INSERT OR UPDATE ON storage.objects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.agsaas_storage_metadata_commit();

CREATE FUNCTION public.get_team_entitlements(p_team uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,storage AS $$
DECLARE ent jsonb; usage jsonb; period_start date;
BEGIN
 PERFORM public.agsaas_quota_lock(p_team); ent:=public.agsaas_team_entitlement(p_team); period_start:=(ent->>'period')::date;
 SELECT jsonb_build_object(
 'users',(SELECT count(distinct user_id) FROM public.users_on_team WHERE team_id=p_team),
 'bankConnections',(SELECT count(*) FROM public.bank_connections WHERE team_id=p_team)+(SELECT count(*) FROM public.bank_connection_cleanups c WHERE c.team_id=p_team AND c.status<>'completed' AND NOT EXISTS(SELECT 1 FROM public.bank_connections b WHERE b.id=c.connection_id)),
 'connectors',(SELECT count(*) FROM public.team_connector_reservations WHERE team_id=p_team AND status<>'released'),
 'storage',(SELECT coalesce(sum(public.agsaas_storage_size(to_jsonb(o))),0) FROM storage.objects o WHERE public.agsaas_storage_team(o.bucket_id,o.name)=p_team),
 'inbox',(SELECT count(*) FROM public.team_quota_usage WHERE team_id=p_team AND kind='inbox' AND period=period_start),
 'invoices',(SELECT count(*) FROM public.team_quota_usage WHERE team_id=p_team AND kind='invoices' AND period=period_start)) INTO usage;
 RETURN ent||jsonb_build_object('usage',usage,'storageMetadataComplete',NOT EXISTS(SELECT 1 FROM storage.objects o WHERE public.agsaas_storage_team(o.bucket_id,o.name)=p_team AND public.agsaas_storage_size(to_jsonb(o)) IS NULL));
END $$;
REVOKE ALL ON FUNCTION public.agsaas_plan_limits(text),public.agsaas_team_entitlement(uuid),public.agsaas_assert_quota(uuid,text,bigint,bigint),public.reserve_generated_storage(uuid,text,text,uuid,bigint),public.get_team_entitlements(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_team_entitlements(uuid),public.reserve_generated_storage(uuid,text,text,uuid,bigint) TO agsaas_app;
