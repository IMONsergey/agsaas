import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { createAssistantActionApproval, listAssistantActionApprovals, resolveAssistantActionApproval, type AssistantActionActor, type AssistantActionPreview } from "../queries/assistant-action-approvals";
import { teams, users, usersOnTeam } from "../schema";
import { closeDatabase, getTestDatabase, isTestDatabaseAvailable } from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())("manual assistant approvals (PostgreSQL)", () => {
  let db: Database;
  beforeAll(() => { db = getTestDatabase(); });
  afterAll(closeDatabase);
  async function fixture(run: (actor: AssistantActionActor, preview: AssistantActionPreview) => Promise<void>) {
    const actor = { userId: randomUUID(), teamId: randomUUID(), sessionId: randomUUID() };
    const preview: AssistantActionPreview = { invoiceId: randomUUID(), revision: "invoice-revision-fixture", recipient: "customer@example.test", bcc: ["copy@example.test"], customerName: "Fixture customer", amount: 125.25, currency: "USD", invoiceNumber: "APPROVAL-1", status: "draft" };
    try {
      await db.execute(sql`INSERT INTO auth.users(id, email) VALUES (${actor.userId}, ${`${actor.userId}@example.test`})`);
      await db.execute(sql`INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES (${actor.sessionId}, ${actor.userId}, now(), now())`);
      await db.insert(teams).values({ id: actor.teamId, inboxId: actor.teamId, name: "Approval fixture" });
      await db.insert(users).values({ id: actor.userId, teamId: actor.teamId, email: `${actor.userId}@example.test` });
      await db.insert(usersOnTeam).values({ teamId: actor.teamId, userId: actor.userId, role: "owner" });
      await run(actor, preview);
    } finally {
      await db.delete(teams).where(eq(teams.id, actor.teamId));
      await db.delete(users).where(eq(users.id, actor.userId));
      await db.execute(sql`DELETE FROM auth.sessions WHERE user_id = ${actor.userId}`);
      await db.execute(sql`DELETE FROM auth.users WHERE id = ${actor.userId}`);
    }
  }
  test("proposal has no side effect, duplicate exact preview reuses the same intent", async () => {
    await fixture(async (actor, preview) => {
      const first = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      const second = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      expect(first.id).toBe(second.id); expect(first.status).toBe("pending");
      expect(first.preview.recipient).toBe(preview.recipient); expect(first.preview.bcc).toEqual(preview.bcc);
      expect((await db.select().from(teams).where(eq(teams.id, actor.teamId)))[0]!.name).toBe("Approval fixture");
    });
  });
  test("one concurrent approval wins; crash/retry returns the saved receipt without another effect", async () => {
    await fixture(async (actor, preview) => {
      const proposal = await createAssistantActionApproval(db, actor, "invoices_delete", preview);
      let calls = 0;
      const execute = async () => { calls++; return { action: "invoices_delete" as const, invoiceId: preview.invoiceId, outcome: "deleted" as const }; };
      const results = await Promise.all([resolveAssistantActionApproval(db, actor, proposal.id, "approve", execute), resolveAssistantActionApproval(db, actor, proposal.id, "approve", execute)]);
      expect(calls).toBe(1); expect(results.every(r => r.status === "succeeded")).toBe(true);
      expect((await resolveAssistantActionApproval(db, actor, proposal.id, "approve", execute)).result).toMatchObject({ outcome: "deleted" });
      expect(calls).toBe(1);
    });
  });
  test("wrong actor/team/browser session cannot list or execute another proposal", async () => {
    await fixture(async (actor, preview) => {
      const proposal = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      let calls = 0;
      for (const changed of [{ userId: randomUUID() }, { teamId: randomUUID() }, { sessionId: randomUUID() }]) {
        const foreign = { ...actor, ...changed };
        expect(await listAssistantActionApprovals(db, foreign)).toEqual([]);
        await expect(resolveAssistantActionApproval(db, foreign, proposal.id, "approve", async () => { calls++; throw new Error("must not execute"); })).rejects.toThrow();
      }
      expect(calls).toBe(0);
    });
  });
  test("expiry, rejection, and stale revisions never execute again", async () => {
    await fixture(async (actor, preview) => {
      const expired = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      await db.execute(sql`UPDATE public.assistant_action_approvals SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE id = ${expired.id}`);
      const never = async () => { throw new Error("must not execute"); };
      expect((await resolveAssistantActionApproval(db, actor, expired.id, "approve", never)).status).toBe("expired");
      const rejected = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      expect((await resolveAssistantActionApproval(db, actor, rejected.id, "reject", never)).status).toBe("rejected");
      expect((await resolveAssistantActionApproval(db, actor, rejected.id, "approve", never)).status).toBe("rejected");
      const stale = await createAssistantActionApproval(db, actor, "invoices_send", { ...preview, revision: "revision-2" });
      expect((await resolveAssistantActionApproval(db, actor, stale.id, "approve", async () => ({ action: "invoices_send", invoiceId: preview.invoiceId, outcome: "stale" }))).status).toBe("stale");
      expect((await resolveAssistantActionApproval(db, actor, stale.id, "approve", never)).status).toBe("stale");
    });
  });
  test("mutation and approval receipt roll back together after a persistence failure", async () => {
    await fixture(async (actor, preview) => {
      const proposal = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      await expect(resolveAssistantActionApproval(db, actor, proposal.id, "approve", async tx => {
        await tx.update(teams).set({ name: "must rollback" }).where(eq(teams.id, actor.teamId));
        throw new Error("injected SQL failure");
      })).rejects.toThrow("injected SQL failure");
      expect((await db.select().from(teams).where(eq(teams.id, actor.teamId)))[0]!.name).toBe("Approval fixture");
      expect((await listAssistantActionApprovals(db, actor))[0]!.status).toBe("pending");
    });
  });
  test("revoked session and removed member cannot execute pending work", async () => {
    await fixture(async (actor, preview) => {
      const proposal = await createAssistantActionApproval(db, actor, "invoices_send", preview);
      await db.execute(sql`DELETE FROM auth.sessions WHERE id = ${actor.sessionId}`);
      await expect(resolveAssistantActionApproval(db, actor, proposal.id, "approve", async () => { throw new Error("must not execute"); })).rejects.toThrow();
      expect(await listAssistantActionApprovals(db, actor)).toEqual([]);
      await db.execute(sql`INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES (${actor.sessionId}, ${actor.userId}, now(), now())`);
      await db.delete(usersOnTeam).where(and(eq(usersOnTeam.userId, actor.userId), eq(usersOnTeam.teamId, actor.teamId)));
      await expect(resolveAssistantActionApproval(db, actor, proposal.id, "approve", async () => { throw new Error("must not execute"); })).rejects.toThrow();
    });
  });
  test("pending proposal budget cannot grow past ten per actor/team", async () => {
    await fixture(async (actor, preview) => {
      for (let i = 0; i < 10; i++) await createAssistantActionApproval(db, actor, "invoices_send", { ...preview, invoiceId: randomUUID() });
      await expect(createAssistantActionApproval(db, actor, "invoices_send", { ...preview, invoiceId: randomUUID() })).rejects.toThrow("Review existing pending actions");
      expect(await listAssistantActionApprovals(db, actor)).toHaveLength(10);
    });
  });
});
