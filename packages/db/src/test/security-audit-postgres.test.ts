import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  appendSecurityAuditEvent,
  listSecurityAuditEvents,
} from "../queries/security-audit";
import { teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "security history (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);
    async function fixture(
      work: (teamId: string, userId: string) => Promise<void>,
    ) {
      const teamId = randomUUID(),
        userId = randomUUID();
      await db
        .insert(teams)
        .values({ id: teamId, inboxId: teamId, name: "Audit fixture" });
      try {
        await work(teamId, userId);
      } finally {
        await db.execute(
          sql`DELETE FROM public.security_audit_events WHERE team_id = ${teamId}::uuid OR actor_user_id = ${userId}::uuid`,
        );
        await db.delete(teams).where(eq(teams.id, teamId));
      }
    }
    test("mutation and journal commit together; persistence failure rolls both back", async () =>
      fixture(async (teamId, actorUserId) => {
        await expect(
          db.transaction(async (tx) => {
            await tx
              .update(teams)
              .set({ name: "must rollback" })
              .where(eq(teams.id, teamId));
            await appendSecurityAuditEvent(tx, {
              teamId,
              actorUserId,
              operation: "team.update",
              targetType: "team",
              targetId: teamId,
            });
            throw new Error("injected commit failure");
          }),
        ).rejects.toThrow("injected");
        expect(
          (await db.select().from(teams).where(eq(teams.id, teamId)))[0]?.name,
        ).toBe("Audit fixture");
        expect(
          (await listSecurityAuditEvents(db, { teamId, actorUserId })).events,
        ).toHaveLength(0);
        await db.transaction(async (tx) => {
          await tx
            .update(teams)
            .set({ name: "committed" })
            .where(eq(teams.id, teamId));
          await appendSecurityAuditEvent(tx, {
            teamId,
            actorUserId,
            operation: "team.update",
            targetType: "team",
            targetId: teamId,
            metadata: { settingsChanged: true },
          });
        });
        expect(
          (await listSecurityAuditEvents(db, { teamId, actorUserId })).events,
        ).toHaveLength(1);
      }));
    test("team/global actor filtering and redaction do not expose another scope", async () =>
      fixture(async (teamId, actorUserId) => {
        await appendSecurityAuditEvent(db, {
          teamId,
          actorUserId,
          operation: "api_key.update",
          targetType: "api_key",
          targetId: randomUUID(),
          metadata: {
            beforeScopes: ["invoices.read"],
            afterScopes: ["invoices.write"],
            token: "secret-fixture",
            email: "pii@example.test",
          },
        });
        await appendSecurityAuditEvent(db, {
          teamId: null,
          actorUserId,
          operation: "session.revoke",
          targetType: "user",
          targetId: actorUserId,
          metadata: { count: 2, scope: "others" },
        });
        const own = await listSecurityAuditEvents(db, { teamId, actorUserId });
        expect(own.events).toHaveLength(2);
        expect(JSON.stringify(own)).not.toContain("secret-fixture");
        expect(JSON.stringify(own)).not.toContain("pii@");
        expect(
          (
            await listSecurityAuditEvents(db, {
              teamId: randomUUID(),
              actorUserId: randomUUID(),
            })
          ).events,
        ).toHaveLength(0);
        expect(
          (
            await listSecurityAuditEvents(db, { teamId: null, actorUserId })
          ).events.map((row) => row.operation),
        ).toEqual(["session.revoke"]);
      }));
    test("ordinary backend grants cannot erase or rewrite history, browser has no grant", async () =>
      fixture(async (teamId, actorUserId) => {
        await appendSecurityAuditEvent(db, {
          teamId,
          actorUserId,
          operation: "team.update",
          targetType: "team",
          targetId: teamId,
        });
        for (const command of [
          sql`UPDATE public.security_audit_events SET operation = 'team.forged' WHERE team_id = ${teamId}::uuid`,
          sql`DELETE FROM public.security_audit_events WHERE team_id = ${teamId}::uuid`,
        ]) {
          await expect(
            db.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL ROLE agsaas_app`);
              await tx.execute(command);
            }),
          ).rejects.toThrow();
        }
        await expect(
          db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE authenticated`);
            await tx.execute(sql`SELECT * FROM public.security_audit_events`);
          }),
        ).rejects.toThrow();
        expect(
          (await listSecurityAuditEvents(db, { teamId })).events,
        ).toHaveLength(1);
      }));
  },
);
