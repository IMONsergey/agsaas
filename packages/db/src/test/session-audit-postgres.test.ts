import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import { isAuthSessionActive } from "../queries/auth-sessions";
import { revokeAuthSessionsWithAudit } from "../queries/revoke-sessions-audited";
import { listSecurityAuditEvents } from "../queries/security-audit";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "atomic session revocation audit",
  () => {
    let db: Database;
    const userId = randomUUID();
    const current = randomUUID();
    const other = randomUUID();
    beforeAll(async () => {
      db = getTestDatabase();
      // Session catalog fixture and complete migrations must run before this suite.
      await db.execute(
        sql`INSERT INTO auth.users(id,email) VALUES (${userId}::uuid,${`${userId}@example.test`})`,
      );
      await db.execute(sql`INSERT INTO auth.sessions(id,user_id,created_at,refreshed_at)
      VALUES (${current}::uuid,${userId}::uuid,now(),now()),
             (${other}::uuid,${userId}::uuid,now(),now())`);
      await db.execute(
        sql`INSERT INTO auth.refresh_tokens(session_id) VALUES (${current}::uuid),(${other}::uuid)`,
      );
    });
    afterAll(async () => {
      if (db) {
        await db.execute(
          sql`DELETE FROM public.security_audit_events WHERE actor_user_id=${userId}::uuid`,
        );
        await db.execute(sql`DELETE FROM auth.users WHERE id=${userId}::uuid`);
      }
      await closeDatabase();
    });
    it("an audit persistence error rolls back session and refresh-token deletion", async () => {
      // Run as a non-owner with a transaction-local permission change: no persistent trigger.
      let failure: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`REVOKE INSERT ON public.security_audit_events FROM agsaas_app`,
          );
          await tx.execute(sql`SET LOCAL ROLE agsaas_app`);
          await revokeAuthSessionsWithAudit(tx, {
            userId,
            currentSessionId: current,
            scope: "others",
          });
          // Keep the fixture privilege change transactional even if the intended fault is absent.
          throw new Error("Audit INSERT unexpectedly succeeded");
        });
      } catch (error) {
        failure = error;
      }
      let postgres:
        | { code?: string; message?: string; cause?: unknown }
        | undefined;
      for (
        let depth = 0;
        depth < 8 && failure && typeof failure === "object";
        depth++
      ) {
        const error = failure as {
          code?: string;
          message?: string;
          cause?: unknown;
        };
        if (error.code) {
          postgres = error;
          break;
        }
        failure = error.cause;
      }
      expect(postgres?.code).toBe("42501");
      expect(postgres?.message).toContain("security_audit_events");
      expect(await isAuthSessionActive(db, userId, other)).toBe(true);
      const refresh = await db.execute(
        sql`SELECT count(*)::int AS count FROM auth.refresh_tokens WHERE session_id=${other}::uuid`,
      );
      expect(refresh.rows[0]?.count).toBe(1);
      expect(
        (
          await listSecurityAuditEvents(db, {
            teamId: null,
            actorUserId: userId,
          })
        ).events,
      ).toHaveLength(0);
    });
    it("commits an own-account receipt without session IDs or personal metadata", async () => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE agsaas_app`);
        return revokeAuthSessionsWithAudit(tx, {
          userId,
          currentSessionId: current,
          scope: "others",
        });
      });
      expect(result).toEqual({ revoked: 1 });
      expect(await isAuthSessionActive(db, userId, other)).toBe(false);
      expect(await isAuthSessionActive(db, userId, current)).toBe(true);
      const history = await listSecurityAuditEvents(db, {
        teamId: null,
        actorUserId: userId,
      });
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.metadata).toEqual({
        count: 1,
        scope: "others",
      });
      expect(JSON.stringify(history)).not.toContain(other);
      expect(
        (
          await listSecurityAuditEvents(db, {
            teamId: null,
            actorUserId: randomUUID(),
          })
        ).events,
      ).toHaveLength(0);
    });
  },
);
