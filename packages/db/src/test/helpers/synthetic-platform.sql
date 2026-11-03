-- TEST FIXTURE ONLY. These are the minimal columns used by the PostgreSQL
-- suites, not Supabase Auth or Storage service schemas. No service migrations,
-- password handling, token issuance, object storage or Realtime are exercised.
-- This file is used only by the exact-instance synthetic foundation helper.
CREATE SCHEMA auth;
CREATE SCHEMA storage;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  banned_until timestamptz,
  deleted_at timestamptz,
  email_confirmed_at timestamptz
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  not_after timestamptz,
  refreshed_at timestamp without time zone,
  user_agent text,
  ip inet
);
CREATE TABLE auth.refresh_tokens (
  id bigserial PRIMARY KEY,
  session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE
);
CREATE TABLE auth.mfa_factors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL
);
CREATE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $fixture$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$fixture$;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $fixture$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid;
$fixture$;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY,
  bucket_id text NOT NULL REFERENCES storage.buckets(id),
  name text NOT NULL,
  owner_id text,
  metadata jsonb,
  version text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  archived_at timestamptz,
  is_delete_marker boolean DEFAULT false,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA auth, storage FROM PUBLIC;
GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC, anon, authenticated, agsaas_app, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM PUBLIC, anon, authenticated, agsaas_app, service_role;
REVOKE ALL ON FUNCTION auth.uid(), auth.jwt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
REVOKE ALL ON storage.buckets, storage.objects FROM PUBLIC;
-- Rows remain subject to the actual application policies installed afterwards.
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, anon;

-- SQL publication membership can be checked; this does not run Realtime.
CREATE PUBLICATION supabase_realtime;
