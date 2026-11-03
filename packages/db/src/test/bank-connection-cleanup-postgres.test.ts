import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { TeamMembershipError } from "../errors";
import {
  beginBankConnectionCleanup,
  finishBankConnectionCleanup,
  getBankConnectionCleanup,
  listBankConnectionCleanupStatus,
  listRecoverableBankConnectionCleanups,
  openBankConnectionCleanup,
} from "../queries/bank-connection-cleanups";
import { deleteBankConnection } from "../queries/bank-connections";
import { deleteTeam } from "../queries/teams";
import { deleteUser } from "../queries/users";
import {
  bankConnectionCleanups,
  bankConnections,
  teams,
  users,
  usersOnTeam,
} from "../schema";
import {
  seedTestProfiles,
  removeTestProfiles,
} from "./helpers/profile-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const testKey = "37".repeat(32);
const secret = "fixture-bank-access-token-not-a-real-credential";

describe.skipIf(!isTestDatabaseAvailable())(
  "durable bank cleanup (PostgreSQL)",
  () => {
    let db: Database;
    let previousKey: string | undefined;
    beforeAll(() => {
      db = getTestDatabase();
      previousKey = process.env.MIDDAY_ENCRYPTION_KEY;
      process.env.MIDDAY_ENCRYPTION_KEY = testKey;
    });
    afterAll(async () => {
      if (previousKey === undefined) delete process.env.MIDDAY_ENCRYPTION_KEY;
      else process.env.MIDDAY_ENCRYPTION_KEY = previousKey;
      await closeDatabase();
    });
    async function fixture(
      run: (f: {
        own: string;
        shared: string;
        foreign: string;
        user: string;
        coOwner: string;
        outsider: string;
        connection: string;
        sharedConnection: string;
        foreignConnection: string;
      }) => Promise<void>,
    ) {
      const f = {
        own: randomUUID(),
        shared: randomUUID(),
        foreign: randomUUID(),
        user: randomUUID(),
        coOwner: randomUUID(),
        outsider: randomUUID(),
        connection: randomUUID(),
        sharedConnection: randomUUID(),
        foreignConnection: randomUUID(),
      };
      const teamIds = [f.own, f.shared, f.foreign];
      const userIds = [f.user, f.coOwner, f.outsider];
      try {
        await db.transaction(async (tx) => {
          await tx.insert(teams).values(
            teamIds.map((id) => ({
              id,
              inboxId: id,
              name: "Bank cleanup fixture",
            })),
          );
          await seedTestProfiles(
            tx,
            userIds.map((id) => ({
              id,
              email: `${id}@example.test`,
              fullName: "Fixture",
              teamId: id === f.outsider ? f.foreign : f.shared,
            })),
          );
          await tx.insert(usersOnTeam).values([
            { teamId: f.own, userId: f.user, role: "owner" },
            { teamId: f.shared, userId: f.user, role: "owner" },
            { teamId: f.shared, userId: f.coOwner, role: "owner" },
            { teamId: f.foreign, userId: f.outsider, role: "owner" },
          ]);
          await tx.insert(bankConnections).values(
            [
              [f.connection, f.own],
              [f.sharedConnection, f.shared],
              [f.foreignConnection, f.foreign],
            ].map(([id, teamId]) => ({
              id: id!,
              teamId: teamId!,
              name: "Fixture",
              institutionId: id!,
              provider: "plaid" as const,
              referenceId: `item-${id}`,
              accessToken: secret,
            })),
          );
        });
        await run(f);
      } finally {
        // Retention ledgers deliberately survive their source rows; remove only
        // these generated fixture identities after their assertions finish.
        const fixtureTeams = sql.join(
          teamIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        );
        const fixtureUsers = sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        );
        await db.execute(
          sql`DELETE FROM public.resource_cleanups WHERE team_id IN (${fixtureTeams}) OR actor_user_id IN (${fixtureUsers})`,
        );
        await db.execute(
          sql`DELETE FROM public.security_audit_events WHERE team_id IN (${fixtureTeams}) OR actor_user_id IN (${fixtureUsers})`,
        );
        await db.execute(
          sql`DELETE FROM public.storage_deletion_tombstones WHERE team_id IN (${fixtureTeams})`,
        );
        await db
          .delete(bankConnectionCleanups)
          .where(inArray(bankConnectionCleanups.teamId, teamIds));
        await db.delete(teams).where(inArray(teams.id, teamIds));
        await db.delete(users).where(inArray(users.id, userIds));
        await removeTestProfiles(db, userIds);
      }
    }
    async function pending(f: {
      connection: string;
      own: string;
      user: string;
    }) {
      const result = await deleteBankConnection(db, {
        id: f.connection,
        teamId: f.own,
        actorId: f.user,
      });
      if (!result) throw new Error("Fixture deletion missing");
      const row = await getBankConnectionCleanup(db, result.cleanupId);
      if (!row) throw new Error("Fixture cleanup missing");
      return row;
    }
    async function claim(id: string) {
      const result = await beginBankConnectionCleanup(db, id, true);
      if (result.state !== "claimed")
        throw new Error(`Expected claim, got ${result.state}`);
      return result;
    }

    test("single connection delete retains encrypted credentials atomically and retries without duplication", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        expect(row.encryptedPayload).not.toContain(secret);
        expect(row.encryptedPayload).not.toContain(`item-${f.connection}`);
        expect(openBankConnectionCleanup(row)).toEqual({
          provider: "plaid",
          referenceId: `item-${f.connection}`,
          accessToken: secret,
        });
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.id, f.connection)),
        ).toHaveLength(0);
        const duplicate = await deleteBankConnection(db, {
          id: f.connection,
          teamId: f.own,
          actorId: f.user,
        });
        expect(duplicate).toEqual({
          id: f.connection,
          cleanupId: row.id,
          cleanupStatus: "pending",
        });
        expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
          1,
        );
      }));

    test("foreign team cannot remove a connection or retrieve its cleanup receipt", async () =>
      fixture(async (f) => {
        expect(
          await deleteBankConnection(db, {
            id: f.connection,
            teamId: f.foreign,
            actorId: f.outsider,
          }),
        ).toBeNull();
        expect(
          await listBankConnectionCleanupStatus(db, f.foreign),
        ).toHaveLength(0);
        const row = await pending(f);
        expect(
          await deleteBankConnection(db, {
            id: f.connection,
            teamId: f.foreign,
            actorId: f.outsider,
          }),
        ).toBeNull();
        const projection = await listBankConnectionCleanupStatus(db, f.own);
        expect(projection[0]?.id).toBe(row.id);
        expect(JSON.stringify(projection)).not.toContain(secret);
        expect(projection[0]).not.toHaveProperty("encryptedPayload");
        expect(projection[0]).not.toHaveProperty("referenceId");
      }));

    test("membership revoked while deletion waits for a team lock cannot delete or retain cleanup", async () =>
      fixture(async (f) => {
        let observed:
          | Promise<{ result?: unknown; error?: unknown }>
          | undefined;
        try {
          await db.transaction(async (tx) => {
            await tx
              .select({ id: teams.id })
              .from(teams)
              .where(eq(teams.id, f.shared))
              .for("update");
            const pid = (
              await tx.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
              )
            ).rows[0]!.pid;
            observed = deleteBankConnection(db, {
              id: f.sharedConnection,
              teamId: f.shared,
              actorId: f.user,
            }).then(
              (result) => ({ result }),
              (error) => ({ error }),
            );
            let waiting = false;
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
              const state = await db.execute<{ waiting: boolean }>(
                sql`select exists(select 1 from pg_stat_activity where ${pid}::integer = any(pg_blocking_pids(pid))) as waiting`,
              );
              if (state.rows[0]?.waiting) {
                waiting = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(waiting).toBe(true);
            await tx
              .delete(usersOnTeam)
              .where(
                and(
                  eq(usersOnTeam.teamId, f.shared),
                  eq(usersOnTeam.userId, f.user),
                ),
              );
          });
        } finally {
          if (observed) await observed;
        }
        const outcome = await observed!;
        expect(outcome.error).toBeInstanceOf(TeamMembershipError);
        expect(outcome.result).toBeUndefined();
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.id, f.sharedConnection)),
        ).toHaveLength(1);
        expect(
          await listBankConnectionCleanupStatus(db, f.shared),
        ).toHaveLength(0);
      }));

    test("missing encryption key rolls back local deletion instead of discarding credentials", async () =>
      fixture(async (f) => {
        delete process.env.MIDDAY_ENCRYPTION_KEY;
        const auth = mock(async () => {});
        try {
          await expect(
            deleteBankConnection(db, {
              id: f.connection,
              teamId: f.own,
              actorId: f.user,
            }),
          ).rejects.toThrow("retained securely");
          await expect(deleteUser(db, f.user, auth)).rejects.toThrow(
            "retained securely",
          );
          expect(auth).not.toHaveBeenCalled();
          expect(
            await db
              .select()
              .from(bankConnections)
              .where(eq(bankConnections.id, f.connection)),
          ).toHaveLength(1);
          expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
            0,
          );
          const [profile] = await db
            .select()
            .from(users)
            .where(eq(users.id, f.user));
          expect(profile?.deletionStartedAt).toBeNull();
        } finally {
          process.env.MIDDAY_ENCRYPTION_KEY = testKey;
        }
      }));

    test("recovery cannot see an uncommitted deletion and an outer rollback removes its intent", async () =>
      fixture(async (f) => {
        await expect(
          db.transaction(async (tx) => {
            const result = await deleteBankConnection(
              tx as unknown as Database,
              { id: f.connection, teamId: f.own, actorId: f.user },
            );
            expect(result).not.toBeNull();
            const outside = await listRecoverableBankConnectionCleanups(db);
            expect(outside.some((item) => item.id === result!.cleanupId)).toBe(
              false,
            );
            throw new Error("fixture transaction rollback");
          }),
        ).rejects.toThrow("fixture transaction rollback");
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.id, f.connection)),
        ).toHaveLength(1);
        expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
          0,
        );
      }));

    test("authorized team deletion commits a cleanup that survives team cascade", async () =>
      fixture(async (f) => {
        await expect(
          deleteTeam(db, { teamId: f.own, userId: f.outsider }),
        ).rejects.toThrow();
        expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
          0,
        );
        const result = await deleteTeam(db, { teamId: f.own, userId: f.user });
        expect(result?.cleanupPending).toBe(1);
        expect(
          await db.select().from(teams).where(eq(teams.id, f.own)),
        ).toHaveLength(0);
        const status = await listBankConnectionCleanupStatus(db, f.own);
        const row = await getBankConnectionCleanup(db, status[0]!.id);
        expect(openBankConnectionCleanup(row!).accessToken).toBe(secret);
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.id, f.foreignConnection)),
        ).toHaveLength(1);
      }));

    test("account deletion captures only solo teams and keeps cleanup through Auth failure and retry", async () =>
      fixture(async (f) => {
        await expect(
          deleteUser(db, f.user, async () => {
            throw new Error("fixture Auth unavailable");
          }),
        ).rejects.toThrow("fixture Auth unavailable");
        expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
          1,
        );
        expect(
          await listBankConnectionCleanupStatus(db, f.shared),
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.id, f.sharedConnection)),
        ).toHaveLength(1);
        expect(
          await db.select().from(teams).where(eq(teams.id, f.own)),
        ).toHaveLength(0);
        await deleteUser(db, f.user, async () => {
          await db.delete(users).where(eq(users.id, f.user));
        });
        expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
          1,
        );
        expect(
          await db.select().from(users).where(eq(users.id, f.user)),
        ).toHaveLength(0);
      }));

    test("shared-team last-owner guard rejects account deletion before any cleanup intent", async () =>
      fixture(async (f) => {
        await db
          .update(usersOnTeam)
          .set({ role: "member" })
          .where(eq(usersOnTeam.userId, f.coOwner));
        const auth = mock(async () => {});
        await expect(deleteUser(db, f.user, auth)).rejects.toThrow(
          "Transfer ownership",
        );
        expect(auth).not.toHaveBeenCalled();
        expect(await listBankConnectionCleanupStatus(db, f.own)).toHaveLength(
          0,
        );
        expect(
          await db.select().from(teams).where(eq(teams.id, f.own)),
        ).toHaveLength(1);
      }));

    test("configuration absence consumes no attempt, time window or ciphertext", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        const result = await beginBankConnectionCleanup(db, row.id, false);
        expect(result.state).toBe("pending");
        expect(result.row?.attempts).toBe(0);
        expect(result.row?.startedAt).toBeNull();
        expect(result.row?.dispatchToken).toBeNull();
        expect(result.row?.encryptedPayload).toBe(row.encryptedPayload);
        expect(result.row?.lastError).toBe("configuration_unavailable");
      }));

    test("concurrent workers share one fence; wrong receipt cannot erase credentials; success does", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        const results = await Promise.all([
          beginBankConnectionCleanup(db, row.id, true),
          beginBankConnectionCleanup(db, row.id, true),
        ]);
        expect(results.map((result) => result.state).sort()).toEqual([
          "busy",
          "claimed",
        ]);
        const winner = results.find((result) => result.state === "claimed")!;
        if (winner.state !== "claimed") throw new Error("Missing winner");
        expect(
          await finishBankConnectionCleanup(db, row.id, randomUUID(), {
            status: "completed",
            reason: "revoked",
          }),
        ).toBeNull();
        expect(
          (await getBankConnectionCleanup(db, row.id))?.encryptedPayload,
        ).toBe(row.encryptedPayload);
        const complete = await finishBankConnectionCleanup(
          db,
          row.id,
          winner.token,
          { status: "completed", reason: "revoked" },
        );
        expect(complete?.encryptedPayload).toBeNull();
        expect(complete?.completedAt).not.toBeNull();
        expect((await beginBankConnectionCleanup(db, row.id, true)).state).toBe(
          "completed",
        );
      }));

    test("crash after dispatch requires reconciliation; a late receipt for the same fence may finish", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        const first = await claim(row.id);
        await db
          .update(bankConnectionCleanups)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(bankConnectionCleanups.id, row.id));
        expect((await beginBankConnectionCleanup(db, row.id, true)).state).toBe(
          "reconciliation",
        );
        expect((await beginBankConnectionCleanup(db, row.id, true)).state).toBe(
          "reconciliation",
        );
        expect((await getBankConnectionCleanup(db, row.id))?.attempts).toBe(1);
        const settled = await finishBankConnectionCleanup(
          db,
          row.id,
          first.token,
          { status: "completed", reason: "revoked" },
        );
        expect(settled?.status).toBe("completed");
        expect(settled?.encryptedPayload).toBeNull();
      }));

    test("only explicit rate limit is retried; ambiguous provider result never replays", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        const first = await claim(row.id);
        expect(
          (
            await finishBankConnectionCleanup(db, row.id, first.token, {
              status: "pending",
              reason: "provider_rate_limit",
            })
          )?.status,
        ).toBe("pending");
        expect((await beginBankConnectionCleanup(db, row.id, true)).state).toBe(
          "pending",
        );
        await db
          .update(bankConnectionCleanups)
          .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(bankConnectionCleanups.id, row.id));
        const next = await claim(row.id);
        expect(next.row.attempts).toBe(2);
        await finishBankConnectionCleanup(db, row.id, next.token, {
          status: "reconciliation",
          reason: "provider_uncertain",
        });
        expect((await beginBankConnectionCleanup(db, row.id, true)).state).toBe(
          "reconciliation",
        );
        expect(
          (await getBankConnectionCleanup(db, row.id))?.encryptedPayload,
        ).toBe(row.encryptedPayload);
      }));

    test("retry budget stops safely and a swapped encrypted target is rejected", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        expect(() =>
          openBankConnectionCleanup({ ...row, teamId: f.foreign }),
        ).toThrow("credentials are unavailable");
        await db
          .update(bankConnectionCleanups)
          .set({
            attempts: 12,
            startedAt: sql`${bankConnectionCleanups.createdAt}`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(bankConnectionCleanups.id, row.id));
        const stopped = await beginBankConnectionCleanup(db, row.id, true);
        expect(stopped.state).toBe("reconciliation");
        expect(stopped.row?.lastError).toBe("attempt_limit");
      }));

    test("recovery projection contains IDs only and includes durable intent with no Redis job", async () =>
      fixture(async (f) => {
        const row = await pending(f);
        const due = await listRecoverableBankConnectionCleanups(db, 100);
        expect(due.find((value) => value.id === row.id)).toEqual({
          id: row.id,
        });
        expect(due.every((value) => Object.keys(value).join() === "id")).toBe(
          true,
        );
      }));
  },
);
