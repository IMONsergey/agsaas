import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { completeIntegrationOAuthIntent, consumeIntegrationOAuthIntent, createIntegrationOAuthIntent, findIntegrationOAuthIntent, type IntegrationOAuthProvider } from "../queries/integration-oauth-intents";
import { teams, users, usersOnTeam } from "../schema";
import { closeDatabase, getTestDatabase, isTestDatabaseAvailable } from "./helpers/test-database";

const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
describe.skipIf(!isTestDatabaseAvailable())("owner OAuth intents (PostgreSQL)", () => {
  let db: Database;
  beforeAll(() => { db = getTestDatabase(); });
  afterAll(closeDatabase);
  async function fixture(run: (f: { teamId: string; userId: string; outsiderId: string }) => Promise<void>) {
    const f = { teamId: randomUUID(), userId: randomUUID(), outsiderId: randomUUID() };
    try {
      await db.insert(teams).values({ id: f.teamId, inboxId: f.teamId, name: "OAuth fixture" });
      await db.insert(users).values([f.userId, f.outsiderId].map(id => ({ id, email: `${id}@example.test`, teamId: f.teamId })));
      await db.insert(usersOnTeam).values({ userId: f.userId, teamId: f.teamId, role: "owner" });
      await run(f);
    } finally {
      await db.delete(teams).where(eq(teams.id, f.teamId));
      await db.delete(users).where(inArray(users.id, [f.userId, f.outsiderId]));
    }
  }
  async function start(f: { teamId: string; userId: string }, provider: IntegrationOAuthProvider = "xero") {
    const params = { ...f, provider, stateHash: hash(), browserNonceHash: hash(), source: "apps" as const, aal: "aal1" as const };
    await createIntegrationOAuthIntent(db, params);
    return params;
  }
  const roleWhere = (f: { userId: string; teamId: string }) => and(eq(usersOnTeam.userId, f.userId), eq(usersOnTeam.teamId, f.teamId));

  test("all providers bind browser and provider; exactly one concurrent callback consumes", async () => {
    await fixture(async f => {
      for (const provider of ["xero", "quickbooks", "fortnox", "slack", "stripe"] as const) {
        const binding = await start(f, provider);
        expect(await consumeIntegrationOAuthIntent(db, { ...binding, browserNonceHash: hash() })).toBeNull();
        expect(await consumeIntegrationOAuthIntent(db, { ...binding, provider: provider === "slack" ? "xero" : "slack" })).toBeNull();
        const outcomes = await Promise.all([consumeIntegrationOAuthIntent(db, binding), consumeIntegrationOAuthIntent(db, binding)]);
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect(outcomes.find(Boolean)).toMatchObject({ teamId: f.teamId, userId: f.userId, provider });
        expect(await consumeIntegrationOAuthIntent(db, binding)).toBeNull();
      }
    });
  });
  test("expired and superseded states fail without consuming the current intent", async () => {
    await fixture(async f => {
      const first = await start(f);
      const latest = await start(f);
      expect(await consumeIntegrationOAuthIntent(db, first)).toBeNull();
      await db.execute(sql`UPDATE public.integration_oauth_intents SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE state_hash = ${latest.stateHash}`);
      expect(await consumeIntegrationOAuthIntent(db, latest)).toBeNull();
    });
  });
  test("nonowners cannot start and a demoted owner cannot consume", async () => {
    await fixture(async f => {
      await expect(start({ ...f, userId: f.outsiderId })).rejects.toThrow();
      const binding = await start(f);
      await db.update(usersOnTeam).set({ role: "member" }).where(roleWhere(f));
      expect(await consumeIntegrationOAuthIntent(db, binding)).toBeNull();
      await expect(start(f)).rejects.toThrow();
      const row = await db.execute<{ consumed_at: string | null }>(sql`SELECT consumed_at FROM public.integration_oauth_intents WHERE state_hash = ${binding.stateHash}`);
      expect(row.rows[0]!.consumed_at).toBeNull();
    });
  });
  test("account deletion is rechecked at callback", async () => {
    await fixture(async f => {
      const binding = await start(f);
      await db.update(users).set({ deletionStartedAt: new Date().toISOString() }).where(eq(users.id, f.userId));
      expect(await consumeIntegrationOAuthIntent(db, binding)).toBeNull();
    });
  });
  test("owner revocation during provider HTTP prevents final persistence", async () => {
    await fixture(async f => {
      const binding = await start(f);
      const intent = (await consumeIntegrationOAuthIntent(db, binding))!;
      await db.update(usersOnTeam).set({ role: "member" }).where(roleWhere(f));
      let writes = 0;
      await expect(completeIntegrationOAuthIntent(db, intent, async tx => { writes++; await tx.update(teams).set({ name: "unauthorized" }).where(eq(teams.id, f.teamId)); })).rejects.toThrow();
      expect(writes).toBe(0);
      expect((await db.select().from(teams).where(eq(teams.id, f.teamId)))[0]!.name).toBe("OAuth fixture");
    });
  });
  test("integration save and completed marker share a transaction, completion cannot replay", async () => {
    await fixture(async f => {
      const binding = await start(f);
      expect(await findIntegrationOAuthIntent(db, binding)).not.toBeNull();
      const intent = (await consumeIntegrationOAuthIntent(db, binding))!;
      await expect(completeIntegrationOAuthIntent(db, intent, async tx => {
        await tx.update(teams).set({ name: "rollback" }).where(eq(teams.id, f.teamId));
        throw new Error("injected persistence failure");
      })).rejects.toThrow("injected persistence failure");
      expect((await db.select().from(teams).where(eq(teams.id, f.teamId)))[0]!.name).toBe("OAuth fixture");
      await completeIntegrationOAuthIntent(db, intent, async tx => { await tx.update(teams).set({ name: "connected" }).where(eq(teams.id, f.teamId)); });
      await expect(completeIntegrationOAuthIntent(db, intent, async () => {})).rejects.toThrow();
      expect((await db.select().from(teams).where(eq(teams.id, f.teamId)))[0]!.name).toBe("connected");
    });
  });
  test("table rejects raw state and Data API roles have no intent privileges", async () => {
    await fixture(async f => {
      await expect(createIntegrationOAuthIntent(db, { ...f, stateHash: "raw-state", browserNonceHash: hash(), provider: "stripe", source: "invoice-settings", aal: "aal2" })).rejects.toThrow();
      const result = await db.execute<{ allowed: boolean }>(sql`SELECT has_table_privilege('authenticated', 'public.integration_oauth_intents', 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('anon', 'public.integration_oauth_intents', 'SELECT,INSERT,UPDATE,DELETE') AS allowed`);
      expect(result.rows[0]!.allowed).toBe(false);
    });
  });
});
