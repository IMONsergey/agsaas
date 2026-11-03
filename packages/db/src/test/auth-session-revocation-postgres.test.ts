import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  getOwnAuthSessions,
  isAuthSessionActive,
  revokeAuthSessions,
} from "../queries/auth-sessions";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";
const suite = isTestDatabaseAvailable() ? describe : describe.skip;
suite("real PostgreSQL browser session revocation", () => {
  let db: Database;
  const alice = randomUUID(),
    bob = randomUUID();
  const current = randomUUID(),
    other = randomUUID(),
    foreign = randomUUID(),
    expired = randomUUID();
  const fixture = sql.identifier(
    `agsaas_session_rls_${randomUUID().replaceAll("-", "")}`,
  );
  let initialized = false;
  beforeAll(async () => {
    db = getTestDatabase();
    // The complete test foundation owns Auth and all production policies. This
    // suite must fail if it is missing, never repair or replace shared catalogs.
    const readiness = await db.execute<{ ready: boolean }>(sql`
     SELECT to_regprocedure('private.auth_session_active(uuid,uuid)') IS NOT NULL
       AND to_regprocedure('private.current_auth_session_active()') IS NOT NULL
       AND to_regprocedure('private.own_auth_sessions(uuid)') IS NOT NULL
       AND to_regprocedure('private.revoke_auth_sessions(uuid,uuid,text)') IS NOT NULL
       AS ready
   `);
    expect(readiness.rows[0]?.ready).toBe(true);
    await db.transaction(async (tx) => {
      // A unique table permits real cross-connection revocation assertions while
      // limiting committed DDL to objects owned by this fixture.
      await tx.execute(sql`CREATE TABLE public.${fixture}(id int PRIMARY KEY)`);
      await tx.execute(sql`INSERT INTO public.${fixture} VALUES(1)`);
      await tx.execute(
        sql`ALTER TABLE public.${fixture} ENABLE ROW LEVEL SECURITY`,
      );
      await tx.execute(sql`CREATE POLICY fixture_permissive ON public.${fixture}
       FOR SELECT TO authenticated USING(true)`);
      await tx.execute(sql`CREATE POLICY fixture_current_session ON public.${fixture}
       AS RESTRICTIVE FOR ALL TO authenticated
       USING ((SELECT private.current_auth_session_active()))
       WITH CHECK ((SELECT private.current_auth_session_active()))`);
      await tx.execute(sql`GRANT SELECT ON public.${fixture} TO authenticated`);
      await tx.execute(sql`INSERT INTO auth.users(id,email)
       VALUES(${alice}::uuid,${`${alice}@example.test`}),
             (${bob}::uuid,${`${bob}@example.test`})`);
      await tx.execute(sql`INSERT INTO auth.sessions(id,user_id,created_at,refreshed_at,not_after,user_agent,ip)VALUES
      (${current}::uuid,${alice}::uuid,now(),now(),NULL,'Local fixture','127.0.0.1'),
      (${other}::uuid,${alice}::uuid,now(),now(),NULL,'Other fixture','127.0.0.2'),
      (${foreign}::uuid,${bob}::uuid,now(),now(),NULL,'Foreign fixture','127.0.0.3'),
      (${expired}::uuid,${alice}::uuid,now(),now(),now()-interval '1 second','Expired fixture',NULL)`);
      await tx.execute(
        sql`INSERT INTO auth.refresh_tokens(session_id)VALUES(${current}::uuid),(${other}::uuid),(${foreign}::uuid)`,
      );
    });
    initialized = true;
  });
  afterAll(async () => {
    try {
      if (initialized)
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`DELETE FROM auth.users WHERE id IN(${alice}::uuid,${bob}::uuid)`,
          );
          await tx.execute(sql`DROP TABLE public.${fixture}`);
        });
    } finally {
      await closeDatabase();
    }
  });
  it("keeps the installed browser session restriction on application and Storage tables", async () => {
    const policies = await db.execute<{
      schemaname: string;
      tablename: string;
      permissive: string;
      cmd: string;
      roles: string[];
      qual: string | null;
      with_check: string | null;
    }>(sql`
     SELECT schemaname,tablename,permissive,cmd,roles,qual,with_check
     FROM pg_policies WHERE policyname='agsaas_current_browser_session'
       AND ((schemaname='public' AND tablename IN ('users','teams','bank_connections'))
         OR (schemaname='storage' AND tablename='objects'))
   `);
    expect(
      policies.rows.map((row) => `${row.schemaname}.${row.tablename}`).sort(),
    ).toEqual([
      "public.bank_connections",
      "public.teams",
      "public.users",
      "storage.objects",
    ]);
    for (const policy of policies.rows) {
      expect(policy.permissive).toBe("RESTRICTIVE");
      expect(policy.cmd).toBe("ALL");
      expect(policy.roles).toContain("authenticated");
      expect(policy.qual).toContain("current_auth_session_active()");
      expect(policy.with_check).toContain("current_auth_session_active()");
    }
  });
  async function visible(user: string, session: string | null) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('request.jwt.claims',${JSON.stringify({ sub: user, role: "authenticated", session_id: session })},true)`,
      );
      await tx.execute(sql.raw("SET LOCAL ROLE authenticated"));
      return (
        await tx.execute(
          sql`SELECT count(*)::int AS count FROM public.${fixture}`,
        )
      ).rows[0]?.count;
    });
  }
  it("requires own, present, unexpired session and a user who is not banned or deleted", async () => {
    expect(await isAuthSessionActive(db, alice, current)).toBe(true);
    expect(await isAuthSessionActive(db, alice, foreign)).toBe(false);
    expect(await isAuthSessionActive(db, alice, expired)).toBe(false);
    await db.execute(
      sql`UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=${alice}::uuid`,
    );
    expect(await isAuthSessionActive(db, alice, current)).toBe(false);
    await db.execute(
      sql`UPDATE auth.users SET banned_until=NULL,deleted_at=now() WHERE id=${alice}::uuid`,
    );
    expect(await isAuthSessionActive(db, alice, current)).toBe(false);
    await db.execute(
      sql`UPDATE auth.users SET deleted_at=NULL WHERE id=${alice}::uuid`,
    );
  });
  it("returns only own active metadata and one current marker", async () => {
    const sessions = await getOwnAuthSessions(db, alice, current);
    expect(sessions.map((s) => s.id).sort()).toEqual([current, other].sort());
    expect(sessions.filter((s) => s.current).map((s) => s.id)).toEqual([
      current,
    ]);
    expect(JSON.stringify(sessions)).not.toContain("refresh_token");
  });
  it("adds a restrictive session check over an otherwise allowing Data API policy", async () => {
    expect(await visible(alice, current)).toBe(1);
    expect(await visible(alice, foreign)).toBe(0);
    expect(await visible(alice, null)).toBe(0);
    expect(await visible(alice, "malformed")).toBe(0);
  });
  it("rolls back session and refresh revocation with its outer transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await revokeAuthSessions(tx, alice, current, "others");
        throw new Error("fixture rollback");
      }),
    ).rejects.toThrow("fixture rollback");
    expect(await isAuthSessionActive(db, alice, other)).toBe(true);
  });
  it("rejects a foreign current-session identity without changing either account", async () => {
    await expect(
      revokeAuthSessions(db, alice, foreign, "all"),
    ).rejects.toThrow();
    expect(await isAuthSessionActive(db, bob, foreign)).toBe(true);
    expect(await isAuthSessionActive(db, alice, current)).toBe(true);
  });
  it("revokes others then all, including refresh rows, with immediate RLS effect", async () => {
    expect(
      (await revokeAuthSessions(db, alice, current, "others")).revoked,
    ).toBe(2);
    expect(await isAuthSessionActive(db, alice, other)).toBe(false);
    expect(await visible(alice, other)).toBe(0);
    expect(await isAuthSessionActive(db, alice, current)).toBe(true);
    expect((await revokeAuthSessions(db, alice, current, "all")).revoked).toBe(
      1,
    );
    expect(await visible(alice, current)).toBe(0);
    expect(await isAuthSessionActive(db, bob, foreign)).toBe(true);
    const left = await db.execute(
      sql`SELECT count(*)::int AS count FROM auth.refresh_tokens WHERE session_id IN(${current}::uuid,${other}::uuid)`,
    );
    expect(left.rows[0]?.count).toBe(0);
  });
});
