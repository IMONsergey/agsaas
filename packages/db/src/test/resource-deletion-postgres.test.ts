import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { deleteDocument } from "../queries/documents";
import { deleteTeam } from "../queries/teams";
import { deleteUser } from "../queries/users";
import { teams, users, usersOnTeam } from "../schema";
import {
  seedTestProfiles,
  removeTestProfiles,
} from "./helpers/profile-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "recoverable resource deletion (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);
    async function fixture(
      work: (
        own: string,
        other: string,
        userId: string,
        otherUser: string,
      ) => Promise<void>,
    ) {
      const own = randomUUID(),
        other = randomUUID(),
        userId = randomUUID(),
        otherUser = randomUUID();
      const ids = [own, other],
        actors = [userId, otherUser];
      try {
        await db
          .insert(teams)
          .values(
            ids.map((id) => ({ id, inboxId: id, name: "Deletion fixture" })),
          );
        await db.transaction((tx) =>
          seedTestProfiles(
            tx,
            actors.map((id, index) => ({
              id,
              teamId: ids[index]!,
              fullName: "Deletion fixture",
              email: `${id}@example.test`,
            })),
          ),
        );
        await db.insert(usersOnTeam).values(
          actors.map((id, index) => ({
            userId: id,
            teamId: ids[index]!,
            role: "owner" as const,
          })),
        );
        for (let index = 0; index < ids.length; index++)
          await db.execute(
            sql`INSERT INTO public.support_requests(id,source,scope_key,payload_hash,team_id,user_id,email,full_name,subject,priority,product,message) VALUES (${randomUUID()}::uuid,'dashboard',${`user:${actors[index]}`},${"a".repeat(64)},${ids[index]}::uuid,${actors[index]}::uuid,'fixture@example.test','Fixture','Fixture request','normal','agsaas','Fixture support message')`,
          );
        await work(own, other, userId, otherUser);
      } finally {
        for (const teamId of ids) {
          await db.execute(
            sql`SELECT private.purge_support_subject(${teamId}::uuid,NULL)`,
          );
          await db.execute(
            sql`DELETE FROM public.resource_cleanups WHERE team_id = ${teamId}::uuid`,
          );
          await db.execute(
            sql`DELETE FROM public.storage_deletion_tombstones WHERE team_id = ${teamId}::uuid`,
          );
          await db.execute(
            sql`DELETE FROM public.security_audit_events WHERE team_id = ${teamId}::uuid`,
          );
        }
        for (const actor of actors) {
          await db.execute(
            sql`SELECT private.purge_support_subject(NULL,${actor}::uuid)`,
          );
          await db.execute(
            sql`DELETE FROM public.resource_cleanups WHERE actor_user_id = ${actor}::uuid`,
          );
          await db.execute(
            sql`DELETE FROM public.security_audit_events WHERE actor_user_id = ${actor}::uuid`,
          );
        }
        await db.delete(teams).where(inArray(teams.id, ids));
        await db.delete(users).where(inArray(users.id, actors));
        await removeTestProfiles(db, actors);
      }
    }
    test("team deletion retains storage/retention work and purges support PII without affecting another tenant", async () =>
      fixture(async (teamId, otherTeamId, userId) => {
        const result = await deleteTeam(db, { teamId, userId });
        expect(result?.cleanupPending).toBeGreaterThanOrEqual(2);
        expect(
          await db.select().from(teams).where(eq(teams.id, teamId)),
        ).toHaveLength(0);
        const retained = await db.execute<{ kind: string }>(
          sql`SELECT kind FROM public.resource_cleanups WHERE team_id = ${teamId}::uuid`,
        );
        expect(retained.rows.map((row) => row.kind)).toEqual(
          expect.arrayContaining(["storage-team", "retention"]),
        );
        expect(
          (
            await db.execute(
              sql`SELECT id FROM public.support_requests WHERE team_id = ${teamId}::uuid`,
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await db.execute(
              sql`SELECT id FROM public.support_requests WHERE team_id = ${otherTeamId}::uuid`,
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          await db.select().from(teams).where(eq(teams.id, otherTeamId)),
        ).toHaveLength(1);
      }));
    test("account deletion failure preserves Auth cleanup and support erasure for recovery", async () =>
      fixture(async (teamId, otherTeamId, userId, otherUser) => {
        await expect(
          deleteUser(db, userId, async () => {
            throw new Error("Auth service offline");
          }),
        ).rejects.toThrow("offline");
        expect(
          (await db.select().from(users).where(eq(users.id, userId)))[0]
            ?.deletionStartedAt,
        ).toBeTruthy();
        expect(
          (
            await db.execute<{ kind: string }>(
              sql`SELECT kind FROM public.resource_cleanups WHERE actor_user_id = ${userId}::uuid`,
            )
          ).rows.map((row) => row.kind),
        ).toContain("auth-user");
        expect(
          (
            await db.execute(
              sql`SELECT id FROM public.support_requests WHERE user_id = ${userId}::uuid`,
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await db.execute(
              sql`SELECT id FROM public.support_requests WHERE user_id = ${otherUser}::uuid`,
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          await db.select().from(teams).where(eq(teams.id, otherTeamId)),
        ).toHaveLength(1);
      }));
    test("a deleted document cannot be recreated by late Storage metadata reconciliation", async () =>
      fixture(async (teamId) => {
        const id = randomUUID(),
          path = `${teamId}/inbox/deletion-fixture.pdf`;
        await db.execute(
          sql`INSERT INTO public.documents(id,team_id,name,path_tokens,title,body) VALUES (${id}::uuid,${teamId}::uuid,${path},ARRAY[${teamId},'inbox','deletion-fixture.pdf'],'Fixture','Fixture')`,
        );
        const result = await deleteDocument(db, { id, teamId });
        expect(result?.cleanupPending).toBe(true);
        const revived = await db.execute(
          sql`INSERT INTO public.documents(id,team_id,name,path_tokens,title,body) VALUES (${randomUUID()}::uuid,${teamId}::uuid,${path},ARRAY[${teamId},'inbox','deletion-fixture.pdf'],'Fixture','Fixture') RETURNING id`,
        );
        expect(revived.rows).toHaveLength(0);
        expect(
          (
            await db.execute(
              sql`SELECT id FROM public.documents WHERE team_id = ${teamId}::uuid AND name = ${path}`,
            )
          ).rows,
        ).toHaveLength(0);
      }));
  },
);
