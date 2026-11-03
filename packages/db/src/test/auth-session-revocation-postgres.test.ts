import{afterAll,beforeAll,describe,expect,it}from"bun:test";
import{randomUUID}from"node:crypto";
import{readFileSync}from"node:fs";
import{join}from"node:path";
import{sql}from"drizzle-orm";
import type{Database}from"../client";
import{getOwnAuthSessions,isAuthSessionActive,revokeAuthSessions}from"../queries/auth-sessions";
import{closeDatabase,getTestDatabase,isTestDatabaseAvailable}from"./helpers/test-database";
const suite=isTestDatabaseAvailable()?describe:describe.skip;
suite("real PostgreSQL browser session revocation",()=>{
 let db:Database;
 const alice=randomUUID(),bob=randomUUID();
 const current=randomUUID(),other=randomUUID(),foreign=randomUUID(),expired=randomUUID();
 const fixture="agsaas_session_rls_fixture";
 beforeAll(async()=>{
   db=getTestDatabase();
   await db.execute(sql.raw(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS private;
    DO $test$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN CREATE ROLE authenticated NOLOGIN;END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')THEN CREATE ROLE anon NOLOGIN;END IF;END $test$;
    CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS not_after timestamptz;
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS created_at timestamptz;
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS refreshed_at timestamp;
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS user_agent text;
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS ip inet;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens(id bigserial PRIMARY KEY,session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE);
    CREATE OR REPLACE FUNCTION auth.jwt()RETURNS jsonb LANGUAGE sql STABLE AS $jwt$
      SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
    $jwt$;
    CREATE OR REPLACE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $uid$
      SELECT nullif(auth.jwt()->>'sub','')::uuid
    $uid$;
    GRANT USAGE ON SCHEMA auth,public TO authenticated;
    CREATE TABLE IF NOT EXISTS public.${fixture}(id int PRIMARY KEY);
    TRUNCATE public.${fixture};
    INSERT INTO public.${fixture} VALUES(1);
    ALTER TABLE public.${fixture} ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS fixture_permissive ON public.${fixture};
    CREATE POLICY fixture_permissive ON public.${fixture} FOR SELECT TO authenticated USING(true);
    GRANT SELECT ON public.${fixture} TO authenticated;
   `));
   await db.execute(sql.raw(readFileSync(join(__dirname,"../../self-hosted/upgrades/supabase/migrations/20261103071000_auth_session_revocation.sql"),"utf8")));
   await db.execute(sql`INSERT INTO auth.users(id)VALUES(${alice}::uuid),(${bob}::uuid)`);
   await db.execute(sql`INSERT INTO auth.sessions(id,user_id,created_at,refreshed_at,not_after,user_agent,ip)VALUES
    (${current}::uuid,${alice}::uuid,now(),now(),NULL,'Local fixture','127.0.0.1'),
    (${other}::uuid,${alice}::uuid,now(),now(),NULL,'Other fixture','127.0.0.2'),
    (${foreign}::uuid,${bob}::uuid,now(),now(),NULL,'Foreign fixture','127.0.0.3'),
    (${expired}::uuid,${alice}::uuid,now(),now(),now()-interval '1 second','Expired fixture',NULL)`);
   await db.execute(sql`INSERT INTO auth.refresh_tokens(session_id)VALUES(${current}::uuid),(${other}::uuid),(${foreign}::uuid)`);
 });
 afterAll(async()=>{
   if(db){
     await db.execute(sql`DELETE FROM auth.users WHERE id IN(${alice}::uuid,${bob}::uuid)`);
     await db.execute(sql.raw(`DROP TABLE IF EXISTS public.${fixture}`));
   }
   await closeDatabase();
 });
 async function visible(user:string,session:string|null){
   return db.transaction(async tx=>{
     await tx.execute(sql`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:user,role:"authenticated",session_id:session})},true)`);
     await tx.execute(sql.raw("SET LOCAL ROLE authenticated"));
     return (await tx.execute(sql.raw(`SELECT count(*)::int AS count FROM public.${fixture}`))).rows[0]?.count;
   });
 }
 it("requires own, present, unexpired session and a user who is not banned or deleted",async()=>{
   expect(await isAuthSessionActive(db,alice,current)).toBe(true);
   expect(await isAuthSessionActive(db,alice,foreign)).toBe(false);
   expect(await isAuthSessionActive(db,alice,expired)).toBe(false);
   await db.execute(sql`UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=${alice}::uuid`);
   expect(await isAuthSessionActive(db,alice,current)).toBe(false);
   await db.execute(sql`UPDATE auth.users SET banned_until=NULL,deleted_at=now() WHERE id=${alice}::uuid`);
   expect(await isAuthSessionActive(db,alice,current)).toBe(false);
   await db.execute(sql`UPDATE auth.users SET deleted_at=NULL WHERE id=${alice}::uuid`);
 });
 it("returns only own active metadata and one current marker",async()=>{
   const sessions=await getOwnAuthSessions(db,alice,current);
   expect(sessions.map(s=>s.id).sort()).toEqual([current,other].sort());
   expect(sessions.filter(s=>s.current).map(s=>s.id)).toEqual([current]);
   expect(JSON.stringify(sessions)).not.toContain("refresh_token");
 });
 it("adds a restrictive session check over an otherwise allowing Data API policy",async()=>{
   expect(await visible(alice,current)).toBe(1);
   expect(await visible(alice,foreign)).toBe(0);
   expect(await visible(alice,null)).toBe(0);
   expect(await visible(alice,"malformed")).toBe(0);
 });
 it("rolls back session and refresh revocation with its outer transaction",async()=>{
   await expect(db.transaction(async tx=>{
     await revokeAuthSessions(tx,alice,current,"others");
     throw new Error("fixture rollback");
   })).rejects.toThrow("fixture rollback");
   expect(await isAuthSessionActive(db,alice,other)).toBe(true);
 });
 it("rejects a foreign current-session identity without changing either account",async()=>{
   await expect(revokeAuthSessions(db,alice,foreign,"all")).rejects.toThrow();
   expect(await isAuthSessionActive(db,bob,foreign)).toBe(true);
   expect(await isAuthSessionActive(db,alice,current)).toBe(true);
 });
 it("revokes others then all, including refresh rows, with immediate RLS effect",async()=>{
   expect((await revokeAuthSessions(db,alice,current,"others")).revoked).toBe(2);
   expect(await isAuthSessionActive(db,alice,other)).toBe(false);
   expect(await visible(alice,other)).toBe(0);
   expect(await isAuthSessionActive(db,alice,current)).toBe(true);
   expect((await revokeAuthSessions(db,alice,current,"all")).revoked).toBe(1);
   expect(await visible(alice,current)).toBe(0);
   expect(await isAuthSessionActive(db,bob,foreign)).toBe(true);
   const left=await db.execute(sql`SELECT count(*)::int AS count FROM auth.refresh_tokens WHERE session_id IN(${current}::uuid,${other}::uuid)`);
   expect(left.rows[0]?.count).toBe(0);
 });
});
