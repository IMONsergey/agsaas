import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database } from "../client";
import { TeamMembershipError } from "../errors";
import {
  createTeam,
  deleteTeam,
  deleteTeamMember,
  leaveTeam,
  updateTeamMember,
} from "../queries/teams";
import { acceptTeamInvite, createTeamInvites } from "../queries/user-invites";
import { deleteUser, getUserById, switchUserTeam } from "../queries/users";
import { withReplicas } from "../replicas";
import { runtimeSchema } from "../runtime-schema";
import {
  bankConnectionCleanups,
  teams,
  userInvites,
  users,
  usersOnTeam,
} from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

type Fixture = {
  teamId: string;
  otherTeamId: string;
  owner: string;
  coOwner: string;
  member: string;
  outsider: string;
  teamIds: string[];
};

// Real transactions/concurrent connections need committed fixtures. The shared
// URL guard accepts only an explicitly configured disposable midday_test DB.
// Cleanup is restricted to the UUIDs created by this suite; no global TRUNCATE.
describe.skipIf(!isTestDatabaseAvailable())(
  "team membership (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withFixture(run: (fixture: Fixture) => Promise<void>) {
      const f: Fixture = {
        teamId: randomUUID(),
        otherTeamId: randomUUID(),
        owner: randomUUID(),
        coOwner: randomUUID(),
        member: randomUUID(),
        outsider: randomUUID(),
        teamIds: [],
      };
      f.teamIds.push(f.teamId, f.otherTeamId);
      const userIds = [f.owner, f.coOwner, f.member, f.outsider];
      try {
        await db.transaction(async (tx) => {
          await tx.insert(teams).values(
            f.teamIds.map((id) => ({
              id,
              name: "Membership fixture",
              inboxId: id,
            })),
          );
          await tx.insert(users).values(
            userIds.map((id) => ({
              id,
              fullName: "Fixture",
              email: `${id}@example.test`,
              teamId: id === f.outsider ? f.otherTeamId : f.teamId,
            })),
          );
          await tx.insert(usersOnTeam).values([
            { userId: f.owner, teamId: f.teamId, role: "owner" },
            { userId: f.coOwner, teamId: f.teamId, role: "owner" },
            { userId: f.member, teamId: f.teamId, role: "member" },
            { userId: f.outsider, teamId: f.otherTeamId, role: "owner" },
          ]);
        });
        await run(f);
      } finally {
        await db.delete(teams).where(inArray(teams.id, f.teamIds));
        await db.delete(users).where(inArray(users.id, userIds));
      }
    }

    test("credential-scoped profile resolves its own team without changing the active profile", async () => {
      await withFixture(async (f) => {
        await db.insert(usersOnTeam).values({
          userId: f.owner,
          teamId: f.otherTeamId,
          role: "member",
        });
        const selected = await getUserById(db, f.owner, {
          teamId: f.otherTeamId,
        });
        expect(selected?.teamId).toBe(f.otherTeamId);
        expect(selected?.team?.id).toBe(f.otherTeamId);
        const original = await getUserById(db, f.owner);
        expect(original?.teamId).toBe(f.teamId);
        expect(original?.team?.id).toBe(f.teamId);
        const noTeam = await getUserById(db, f.owner, { teamId: null });
        expect(noTeam?.teamId).toBeNull();
        expect(noTeam?.team).toBeNull();
      });
    });

    async function members(teamId: string) {
      return db
        .select()
        .from(usersOnTeam)
        .where(eq(usersOnTeam.teamId, teamId));
    }
    async function profile(userId: string) {
      return db.query.users.findFirst({ where: eq(users.id, userId) });
    }
    async function teamExists(teamId: string) {
      return Boolean(
        await db.query.teams.findFirst({ where: eq(teams.id, teamId) }),
      );
    }
    async function onlyOneOwner(f: Fixture) {
      await db
        .update(usersOnTeam)
        .set({ role: "member" })
        .where(
          and(
            eq(usersOnTeam.teamId, f.teamId),
            eq(usersOnTeam.userId, f.coOwner),
          ),
        );
    }
    async function addSoloTeam(f: Fixture, owner = f.owner) {
      const teamId = randomUUID();
      f.teamIds.push(teamId);
      await db
        .insert(teams)
        .values({ id: teamId, name: "Solo fixture", inboxId: teamId });
      await db
        .insert(usersOnTeam)
        .values({ teamId, userId: owner, role: "owner" });
      return teamId;
    }
    async function addInvite(
      f: Fixture,
      userId: string,
      role: "owner" | "member" = "member",
    ) {
      const id = randomUUID();
      await db.insert(userInvites).values({
        id,
        teamId: f.teamId,
        email: `${userId}@example.test`,
        role,
        invitedBy: f.owner,
        code: randomUUID(),
      });
      return id;
    }
    // Emulates Auth's profile cascade on another DB connection, with a deadline
    // that detects accidental row locks held across the external callback.
    async function authCascade(userId: string) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
        await tx.delete(users).where(eq(users.id, userId));
      });
    }

    for (const actor of ["member", "outsider"] as const) {
      test(`${actor} cannot delete a team or queue its cleanup`, async () => {
        await withFixture(async (f) => {
          await expect(
            deleteTeam(db, { teamId: f.teamId, userId: f[actor] }),
          ).rejects.toBeInstanceOf(TeamMembershipError);
          expect(
            await db
              .select()
              .from(bankConnectionCleanups)
              .where(eq(bankConnectionCleanups.teamId, f.teamId)),
          ).toHaveLength(0);
          expect(await teamExists(f.teamId)).toBe(true);
          expect(await members(f.teamId)).toHaveLength(3);
        });
      });
    }

    test("an owner may delete a joined team that is not active", async () => {
      await withFixture(async (f) => {
        await db
          .update(users)
          .set({ teamId: null })
          .where(eq(users.id, f.owner));
        const result = await deleteTeam(db, {
          teamId: f.teamId,
          userId: f.owner,
        });
        expect(result?.memberUserIds.sort()).toEqual(
          [f.owner, f.coOwner, f.member].sort(),
        );
        expect(result?.cleanupPending).toBe(0);
        expect(await teamExists(f.teamId)).toBe(false);
        expect(await teamExists(f.otherTeamId)).toBe(true);
      });
    });

    test("a deletion retry cannot reuse authorization for a deleted team", async () => {
      await withFixture(async (f) => {
        await deleteTeam(db, { teamId: f.teamId, userId: f.owner });
        await expect(
          deleteTeam(db, { teamId: f.teamId, userId: f.owner }),
        ).rejects.toBeInstanceOf(TeamMembershipError);
        expect(await teamExists(f.teamId)).toBe(false);
        expect(await teamExists(f.otherTeamId)).toBe(true);
      });
    });

    test("membership changes require the actual actor to be an owner", async () => {
      await withFixture(async (f) => {
        await expect(
          updateTeamMember(db, {
            teamId: f.teamId,
            userId: f.member,
            actorId: f.member,
            role: "owner",
          }),
        ).rejects.toThrow("Only team owners");
        await expect(
          deleteTeamMember(db, {
            teamId: f.teamId,
            userId: f.owner,
            actorId: f.member,
          }),
        ).rejects.toThrow("Only team owners");
        expect(
          (await members(f.teamId)).find((m) => m.userId === f.member)?.role,
        ).toBe("member");
      });
    });

    const departures = {
      leave: (f: Fixture, userId: string) =>
        leaveTeam(db, { teamId: f.teamId, userId }),
      demote: (f: Fixture, userId: string) =>
        updateTeamMember(db, {
          teamId: f.teamId,
          userId,
          actorId: userId,
          role: "member",
        }),
      remove: (f: Fixture, userId: string) =>
        deleteTeamMember(db, { teamId: f.teamId, userId, actorId: userId }),
    };
    for (const [name, depart] of Object.entries(departures)) {
      test(`last owner cannot ${name}, including duplicate ownership rows`, async () => {
        await withFixture(async (f) => {
          await onlyOneOwner(f);
          await db
            .insert(usersOnTeam)
            .values({ teamId: f.teamId, userId: f.owner, role: "owner" });
          await expect(depart(f, f.owner)).rejects.toThrow(
            "Transfer ownership",
          );
          expect(
            (await members(f.teamId)).filter((m) => m.role === "owner"),
          ).toHaveLength(2);
          expect((await profile(f.owner))?.teamId).toBe(f.teamId);
        });
      });
      test(`concurrent owner ${name} operations leave one distinct owner`, async () => {
        await withFixture(async (f) => {
          const results = await Promise.allSettled([
            depart(f, f.owner),
            depart(f, f.coOwner),
          ]);
          expect(
            results.filter((result) => result.status === "fulfilled"),
          ).toHaveLength(1);
          expect(
            results.filter((result) => result.status === "rejected"),
          ).toHaveLength(1);
          expect(
            new Set(
              (await members(f.teamId))
                .filter((m) => m.role === "owner")
                .map((m) => m.userId),
            ).size,
          ).toBe(1);
        });
      });
    }

    test("concurrent cross-removal cannot remove both owners", async () => {
      await withFixture(async (f) => {
        const results = await Promise.allSettled([
          deleteTeamMember(db, {
            teamId: f.teamId,
            userId: f.coOwner,
            actorId: f.owner,
          }),
          deleteTeamMember(db, {
            teamId: f.teamId,
            userId: f.owner,
            actorId: f.coOwner,
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          (await members(f.teamId)).filter((m) => m.role === "owner"),
        ).toHaveLength(1);
      });
    });

    test("member removal clears only the removed active team", async () => {
      await withFixture(async (f) => {
        await deleteTeamMember(db, {
          teamId: f.teamId,
          userId: f.member,
          actorId: f.owner,
        });
        expect((await profile(f.member))?.teamId).toBeNull();
        await db
          .insert(usersOnTeam)
          .values({ teamId: f.teamId, userId: f.outsider, role: "member" });
        await deleteTeamMember(db, {
          teamId: f.teamId,
          userId: f.outsider,
          actorId: f.owner,
        });
        expect((await profile(f.outsider))?.teamId).toBe(f.otherTeamId);
      });
    });

    test("a member may leave a non-active team without losing the active team", async () => {
      await withFixture(async (f) => {
        await db
          .insert(usersOnTeam)
          .values({ teamId: f.teamId, userId: f.outsider, role: "member" });
        await leaveTeam(db, { teamId: f.teamId, userId: f.outsider });
        expect((await profile(f.outsider))?.teamId).toBe(f.otherTeamId);
      });
    });

    test("switch racing removal cannot leave an unauthorized active team", async () => {
      await withFixture(async (f) => {
        await db
          .update(users)
          .set({ teamId: null })
          .where(eq(users.id, f.member));
        await Promise.allSettled([
          switchUserTeam(db, { userId: f.member, teamId: f.teamId }),
          deleteTeamMember(db, {
            actorId: f.owner,
            userId: f.member,
            teamId: f.teamId,
          }),
        ]);
        expect((await profile(f.member))?.teamId).toBeNull();
        expect(
          (await members(f.teamId)).some((m) => m.userId === f.member),
        ).toBe(false);
      });
    });

    test("a mixed owner/member invite batch from a member is rejected before any insert", async () => {
      await withFixture(async (f) => {
        await expect(
          createTeamInvites(db, {
            teamId: f.teamId,
            actorId: f.member,
            invites: [
              {
                email: "member@example.test",
                role: "member",
                invitedBy: f.member,
              },
              {
                email: "owner@example.test",
                role: "owner",
                invitedBy: f.owner,
              },
            ],
          }),
        ).rejects.toThrow("Only team owners");
        expect(
          await db
            .select()
            .from(userInvites)
            .where(eq(userInvites.teamId, f.teamId)),
        ).toHaveLength(0);
      });
    });

    test("ordinary members may invite members; actors cannot be spoofed", async () => {
      await withFixture(async (f) => {
        const result = await createTeamInvites(db, {
          teamId: f.teamId,
          actorId: f.member,
          invites: [
            {
              email: " First@Example.Test ",
              role: "member",
              invitedBy: f.owner,
            },
            {
              email: "second@example.test",
              role: "member",
              invitedBy: f.owner,
            },
          ],
        });
        expect(result.results).toHaveLength(2);
        const rows = await db
          .select()
          .from(userInvites)
          .where(eq(userInvites.teamId, f.teamId));
        expect(rows.every((row) => row.invitedBy === f.member)).toBe(true);
        expect(new Set(rows.map((row) => row.code)).size).toBe(2);
        expect(rows.map((row) => row.email)).toContain("first@example.test");
      });
    });

    test("owners may invite another owner", async () => {
      await withFixture(async (f) => {
        const result = await createTeamInvites(db, {
          teamId: f.teamId,
          actorId: f.owner,
          invites: [
            {
              email: "next-owner@example.test",
              role: "owner",
              invitedBy: f.owner,
            },
          ],
        });
        expect(result.results[0]?.role).toBe("owner");
      });
    });

    test("concurrent acceptance creates one membership and consumes the invitation once", async () => {
      await withFixture(async (f) => {
        const id = await addInvite(f, f.outsider);
        const params = {
          id,
          userId: f.outsider,
          userEmail: `${f.outsider.toUpperCase()}@EXAMPLE.TEST`,
        };
        const results = await Promise.allSettled([
          acceptTeamInvite(db, params),
          acceptTeamInvite(db, params),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          (await members(f.teamId)).filter((m) => m.userId === f.outsider),
        ).toHaveLength(1);
        expect(
          await db.query.userInvites.findFirst({
            where: eq(userInvites.id, id),
          }),
        ).toBeUndefined();
      });
    });

    test("wrong-email acceptance cannot insert membership or consume an invite", async () => {
      await withFixture(async (f) => {
        const id = await addInvite(f, f.outsider);
        await expect(
          acceptTeamInvite(db, {
            id,
            userId: f.member,
            userEmail: `${f.member}@example.test`,
          }),
        ).rejects.toThrow("different email");
        expect(
          await db.query.userInvites.findFirst({
            where: eq(userInvites.id, id),
          }),
        ).toBeDefined();
        expect(await members(f.teamId)).toHaveLength(3);
      });
    });

    test("an old pending owner invite does not upgrade an existing member", async () => {
      await withFixture(async (f) => {
        const id = await addInvite(f, f.member, "owner");
        await acceptTeamInvite(db, {
          id,
          userId: f.member,
          userEmail: `${f.member}@example.test`,
        });
        const rows = (await members(f.teamId)).filter(
          (m) => m.userId === f.member,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.role).toBe("member");
      });
    });

    test("account deletion validates every shared team before changing solo teams or Auth", async () => {
      await withFixture(async (f) => {
        await onlyOneOwner(f);
        const soloTeam = await addSoloTeam(f);
        const removeAuth = mock(async () => {});
        await expect(deleteUser(db, f.owner, removeAuth)).rejects.toThrow(
          "Transfer ownership",
        );
        expect(removeAuth).not.toHaveBeenCalled();
        expect(await teamExists(soloTeam)).toBe(true);
        expect((await profile(f.owner))?.teamId).toBe(f.teamId);
        expect((await profile(f.owner))?.deletionStartedAt).toBeNull();
        expect(await members(f.teamId)).toHaveLength(3);
      });
    });

    test("account deletion preserves shared teams and lets a separate Auth connection cascade the profile", async () => {
      await withFixture(async (f) => {
        const soloTeam = await addSoloTeam(f);
        // Duplicates still represent a single actual user, not a shared company.
        await db
          .insert(usersOnTeam)
          .values({ teamId: soloTeam, userId: f.owner, role: "owner" });
        const result = await deleteUser(db, f.owner, async () => {
          expect(await profile(f.owner)).toBeDefined();
          await authCascade(f.owner);
        });
        expect(result).toEqual({ id: f.owner });
        expect(await profile(f.owner)).toBeUndefined();
        expect(await teamExists(soloTeam)).toBe(false);
        expect(await teamExists(f.teamId)).toBe(true);
        expect((await members(f.teamId)).map((m) => m.userId).sort()).toEqual(
          [f.coOwner, f.member].sort(),
        );
        expect(await teamExists(f.otherTeamId)).toBe(true);
      });
    });

    test("a definite Auth rejection leaves a profile for retry, without restoring access already removed", async () => {
      await withFixture(async (f) => {
        await expect(
          deleteUser(db, f.owner, async () => {
            throw new Error("Auth rejected deletion");
          }),
        ).rejects.toThrow("Auth rejected");
        expect((await profile(f.owner))?.teamId).toBeNull();
        expect((await profile(f.owner))?.deletionStartedAt).toBeTruthy();
        expect(
          (await members(f.teamId)).some((m) => m.userId === f.owner),
        ).toBe(false);
        expect(
          await deleteUser(db, f.owner, () => authCascade(f.owner)),
        ).toEqual({ id: f.owner });
        expect(await profile(f.owner)).toBeUndefined();
        expect(await teamExists(f.teamId)).toBe(true);
      });
    });

    test("an ordinary member can delete their own account without deleting the shared team", async () => {
      await withFixture(async (f) => {
        await deleteUser(db, f.member, () => authCascade(f.member));
        expect(await teamExists(f.teamId)).toBe(true);
        expect(await members(f.teamId)).toHaveLength(2);
      });
    });

    test("two concurrent account deletions cannot leave remaining members without an owner", async () => {
      await withFixture(async (f) => {
        const results = await Promise.allSettled([
          deleteUser(db, f.owner, () => authCascade(f.owner)),
          deleteUser(db, f.coOwner, () => authCascade(f.coOwner)),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        expect(
          (await members(f.teamId)).filter((m) => m.role === "owner"),
        ).toHaveLength(1);
        expect(await profile(f.member)).toBeDefined();
      });
    });

    test("a durable marker blocks membership while Auth is pending without retaining DB locks", async () => {
      await withFixture(async (f) => {
        const id = await addInvite(f, f.outsider);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const deletion = deleteUser(db, f.outsider, async () => {
          entered.resolve();
          await release.promise;
          await authCascade(f.outsider);
        });
        let acceptance: Promise<unknown> | undefined;
        try {
          await entered.promise;
          const lockProbe = await db.transaction(async (tx) => {
            const result = await tx.execute(
              sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`agsaas:membership:${f.outsider}`}, 0)) AS acquired`,
            );
            return result.rows[0]?.acquired;
          });
          expect(lockProbe).toBe(true);
          expect((await profile(f.outsider))?.deletionStartedAt).toBeTruthy();
          acceptance = acceptTeamInvite(db, {
            id,
            userId: f.outsider,
            userEmail: `${f.outsider}@example.test`,
          }).then(
            () => "unexpected success",
            () => "rejected",
          );
          // Must reject while HTTP is pending, not wait for the Auth callback.
          expect(await acceptance).toBe("rejected");
        } finally {
          release.resolve();
          await deletion;
        }
        expect(await acceptance).toBe("rejected");
        expect(
          (await members(f.teamId)).some((m) => m.userId === f.outsider),
        ).toBe(false);
        expect(
          await db.query.userInvites.findFirst({
            where: eq(userInvites.id, id),
          }),
        ).toBeDefined();
      });
    });
    test("a locally failed Auth request cannot acquire new ownership before delayed remote completion", async () => {
      await withFixture(async (f) => {
        const inviteId = await addInvite(f, f.outsider, "owner");
        await expect(
          deleteUser(db, f.outsider, async () => {
            throw new Error("ambiguous transport failure");
          }),
        ).rejects.toThrow("ambiguous transport");

        await expect(
          acceptTeamInvite(db, {
            id: inviteId,
            userId: f.outsider,
            userEmail: `${f.outsider}@example.test`,
          }),
        ).rejects.toThrow("Account deletion is pending");
        await expect(
          createTeam(db, {
            userId: f.outsider,
            email: `${f.outsider}@example.test`,
            name: "Must not be created",
          }),
        ).rejects.toThrow("Account deletion is pending");
        await expect(
          switchUserTeam(db, { userId: f.outsider, teamId: f.teamId }),
        ).rejects.toThrow("Account deletion is pending");

        // The original remote request may still complete AFTER the local error.
        await authCascade(f.outsider);
        expect(await profile(f.outsider)).toBeUndefined();
        expect(
          (await members(f.teamId)).filter((m) => m.role === "owner"),
        ).toHaveLength(2);
        expect(await members(f.teamId)).toHaveLength(3);
      });
    });

    test("account deletion and duplicate retries work with a one-connection pool", async () => {
      await withFixture(async (f) => {
        const pool = new Pool({
          connectionString: getTestDatabaseUrl(),
          max: 1,
          connectionTimeoutMillis: 500,
        });
        const primary = drizzle(pool, {
          schema: runtimeSchema,
          casing: "snake_case",
        });
        const limitedDb = withReplicas(
          primary,
          [primary],
          (replicas) => replicas[0]!,
        );
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const deletion = deleteUser(limitedDb, f.owner, async () => {
          entered.resolve();
          await release.promise;
        });
        // A nested pool transaction would reject before reaching the callback.
        const observed = deletion.then(
          (value) => ({ value }),
          (error: unknown) => {
            entered.reject(error);
            return { error };
          },
        );
        try {
          await entered.promise;
          expect(pool.idleCount).toBe(1);
          await limitedDb.execute(sql`SELECT 1`);
          const retry = await deleteUser(limitedDb, f.owner, async () => {});
          expect(retry).toEqual({ id: f.owner });
        } finally {
          release.resolve();
          await observed;
          await pool.end();
        }
        const result = await observed;
        if ("error" in result) throw result.error;
        expect(await profile(f.owner)).toBeUndefined();
        expect(await teamExists(f.teamId)).toBe(true);
      });
    });
  },
);
