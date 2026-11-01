import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import {
  claimDCRApplication,
  deleteOAuthApplication,
  getOAuthApplicationById,
  getOAuthApplicationBySlug,
  getOAuthApplicationsByTeam,
  regenerateClientSecret,
  updateOAuthApplication,
} from "../queries/oauth-applications";
import {
  createAccessToken,
  createAuthorizationCode,
  refreshAccessToken,
  validateAccessToken,
} from "../queries/oauth-flow";
import { deleteTeam, leaveTeam } from "../queries/teams";
import { deleteUser } from "../queries/users";
import {
  oauthAccessTokens,
  oauthApplications,
  oauthAuthorizationCodes,
  teams,
  users,
  usersOnTeam,
} from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

type Grant = Awaited<ReturnType<typeof createAccessToken>>;
type Fixture = {
  teamId: string;
  consumerTeamId: string;
  authorId: string;
  survivorId: string;
  memberId: string;
  consumerId: string;
  applicationId: string;
  controlApplicationId: string;
  grants: Map<string, Grant>;
};

// Real SQL/query functions in the guarded disposable midday_test database.
// Fixtures commit for the deleteUser callback's separate connection. Cleanup
// touches only these UUIDs; this is not an Auth HTTP/JWT or browser RLS test.
describe.skipIf(!isTestDatabaseAvailable())(
  "team OAuth application retention (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withFixture(run: (f: Fixture) => Promise<void>) {
      const f: Fixture = {
        teamId: randomUUID(),
        consumerTeamId: randomUUID(),
        authorId: randomUUID(),
        survivorId: randomUUID(),
        memberId: randomUUID(),
        consumerId: randomUUID(),
        applicationId: randomUUID(),
        controlApplicationId: randomUUID(),
        grants: new Map(),
      };
      const userIds = [f.authorId, f.survivorId, f.memberId, f.consumerId];
      try {
        await db.transaction(async (tx) => {
          await tx.insert(teams).values(
            [f.teamId, f.consumerTeamId].map((id) => ({
              id,
              name: "OAuth retention fixture",
              inboxId: id,
            })),
          );
          await tx.insert(users).values(
            userIds.map((id) => ({
              id,
              fullName: "OAuth retention fixture user",
              email: `${id}@example.test`,
              teamId: id === f.consumerId ? f.consumerTeamId : f.teamId,
            })),
          );
          await tx.insert(usersOnTeam).values([
            { userId: f.authorId, teamId: f.teamId, role: "owner" },
            { userId: f.survivorId, teamId: f.teamId, role: "owner" },
            { userId: f.memberId, teamId: f.teamId, role: "member" },
            {
              userId: f.consumerId,
              teamId: f.consumerTeamId,
              role: "owner",
            },
          ]);
          await tx.insert(oauthApplications).values([
            {
              id: f.applicationId,
              teamId: f.teamId,
              createdBy: f.authorId,
              name: "Retained OAuth client",
              slug: `retained-${f.applicationId}`,
              clientId: `fixture-client-${f.applicationId}`,
              clientSecret: `fixture-secret-hash-${f.applicationId}`,
              redirectUris: ["https://example.test/callback"],
              scopes: ["invoices.read"],
              active: true,
              status: "approved",
            },
            {
              id: f.controlApplicationId,
              teamId: f.consumerTeamId,
              createdBy: f.consumerId,
              name: "Unaffected OAuth client",
              slug: `control-${f.controlApplicationId}`,
              clientId: `fixture-client-${f.controlApplicationId}`,
              redirectUris: ["https://example.test/callback"],
              scopes: ["invoices.read"],
              active: true,
            },
          ]);
        });
        for (const userId of userIds) {
          const grantTeamId =
            userId === f.consumerId ? f.consumerTeamId : f.teamId;
          f.grants.set(
            userId,
            await createAccessToken(db, {
              applicationId: f.applicationId,
              userId,
              teamId: grantTeamId,
              scopes: ["invoices.read"],
            }),
          );
          await createAuthorizationCode(db, {
            applicationId: f.applicationId,
            userId,
            teamId: grantTeamId,
            scopes: ["invoices.read"],
            redirectUri: "https://example.test/callback",
          });
        }
        await run(f);
      } finally {
        await db
          .delete(teams)
          .where(inArray(teams.id, [f.teamId, f.consumerTeamId]));
        await db.delete(users).where(inArray(users.id, userIds));
      }
    }

    async function application(f: Fixture) {
      return db.query.oauthApplications.findFirst({
        where: eq(oauthApplications.id, f.applicationId),
      });
    }

    async function grantsForApplication(f: Fixture) {
      const tokens = await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.applicationId, f.applicationId))
        .orderBy(oauthAccessTokens.id);
      const codes = await db
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.applicationId, f.applicationId))
        .orderBy(oauthAuthorizationCodes.id);
      return { tokens, codes };
    }

    async function deleteProfile(userId: string) {
      await db.delete(users).where(eq(users.id, userId));
    }

    test("direct creator deletion retains the client unchanged except authorship and removes only personal grants", async () => {
      await withFixture(async (f) => {
        const before = await application(f);
        if (!before) throw new Error("Missing OAuth fixture application");
        const grants = await grantsForApplication(f);
        await deleteProfile(f.authorId);
        expect(await application(f)).toEqual({ ...before, createdBy: null });
        expect(await grantsForApplication(f)).toEqual({
          tokens: grants.tokens.filter((row) => row.userId !== f.authorId),
          codes: grants.codes.filter((row) => row.userId !== f.authorId),
        });
        expect(
          await validateAccessToken(db, f.grants.get(f.authorId)!.accessToken),
        ).toBeNull();
        for (const userId of [f.survivorId, f.memberId, f.consumerId]) {
          expect(
            await validateAccessToken(db, f.grants.get(userId)!.accessToken),
          ).toMatchObject({ userId, applicationId: f.applicationId });
        }
      });
    });

    test("account deletion retains a shared-team application and the remaining owner's management view", async () => {
      await withFixture(async (f) => {
        await deleteUser(db, f.authorId, () => deleteProfile(f.authorId));
        expect(
          await getOAuthApplicationById(db, f.applicationId, f.teamId),
        ).toMatchObject({
          id: f.applicationId,
          teamId: f.teamId,
          createdBy: null,
          createdByUser: null,
        });
        expect(await getOAuthApplicationsByTeam(db, f.teamId)).toMatchObject([
          { id: f.applicationId, createdBy: null, createdByUser: null },
        ]);
        expect(
          await getOAuthApplicationBySlug(
            db,
            `retained-${f.applicationId}`,
            f.teamId,
          ),
        ).toMatchObject({ id: f.applicationId, createdByUser: null });
        expect(
          await updateOAuthApplication(db, {
            id: f.applicationId,
            teamId: f.teamId,
            description: "Maintained by the surviving team",
          }),
        ).toMatchObject({
          createdBy: null,
          description: "Maintained by the surviving team",
        });
        expect(
          await regenerateClientSecret(db, f.applicationId, f.teamId),
        ).toMatchObject({ id: f.applicationId });
      });
    });

    test("former creator deletion still preserves the application after leaving its team", async () => {
      await withFixture(async (f) => {
        const before = await application(f);
        if (!before) throw new Error("Missing OAuth fixture application");
        await leaveTeam(db, { userId: f.authorId, teamId: f.teamId });
        expect(
          await validateAccessToken(db, f.grants.get(f.authorId)!.accessToken),
        ).toBeNull();
        await expect(
          refreshAccessToken(db, {
            applicationId: f.applicationId,
            refreshToken: f.grants.get(f.authorId)!.refreshToken,
          }),
        ).rejects.toThrow("Invalid refresh token");
        await deleteUser(db, f.authorId, () => deleteProfile(f.authorId));
        expect(await application(f)).toEqual({ ...before, createdBy: null });
        expect(
          await validateAccessToken(
            db,
            f.grants.get(f.survivorId)!.accessToken,
          ),
        ).toMatchObject({ userId: f.survivorId });
      });
    });

    test("retained authorless client cannot be claimed or managed by another team", async () => {
      await withFixture(async (f) => {
        await deleteProfile(f.authorId);
        const before = await application(f);
        expect(
          await claimDCRApplication(
            db,
            f.applicationId,
            f.consumerTeamId,
            f.consumerId,
          ),
        ).toBeUndefined();
        expect(
          await getOAuthApplicationById(db, f.applicationId, f.consumerTeamId),
        ).toBeUndefined();
        expect(
          await updateOAuthApplication(db, {
            id: f.applicationId,
            teamId: f.consumerTeamId,
            name: "Foreign team overwrite",
          }),
        ).toBeUndefined();
        expect(
          await regenerateClientSecret(db, f.applicationId, f.consumerTeamId),
        ).toBeNull();
        expect(
          await deleteOAuthApplication(db, {
            id: f.applicationId,
            teamId: f.consumerTeamId,
          }),
        ).toBeUndefined();
        expect(await application(f)).toEqual(before);
      });
    });

    test("other-team consumers can refresh their own grant after the creator is deleted", async () => {
      await withFixture(async (f) => {
        await deleteProfile(f.authorId);
        const refreshed = await refreshAccessToken(db, {
          applicationId: f.applicationId,
          refreshToken: f.grants.get(f.consumerId)!.refreshToken,
        });
        expect(
          await validateAccessToken(db, refreshed.accessToken),
        ).toMatchObject({ userId: f.consumerId, teamId: f.consumerTeamId });
        expect(
          await validateAccessToken(
            db,
            f.grants.get(f.consumerId)!.accessToken,
          ),
        ).toBeNull();
      });
    });

    test("membership in a different team does not preserve a removed member's grant", async () => {
      await withFixture(async (f) => {
        await db.insert(usersOnTeam).values({
          userId: f.memberId,
          teamId: f.consumerTeamId,
          role: "member",
        });
        await leaveTeam(db, { userId: f.memberId, teamId: f.teamId });
        const before = await grantsForApplication(f);
        expect(
          await validateAccessToken(db, f.grants.get(f.memberId)!.accessToken),
        ).toBeNull();
        await expect(
          refreshAccessToken(db, {
            applicationId: f.applicationId,
            refreshToken: f.grants.get(f.memberId)!.refreshToken,
          }),
        ).rejects.toThrow("Invalid refresh token");
        expect(await grantsForApplication(f)).toEqual(before);
      });
    });

    test("pending account deletion denies grant use and refresh even if a membership row remains", async () => {
      await withFixture(async (f) => {
        await db
          .update(users)
          .set({ deletionStartedAt: new Date().toISOString() })
          .where(eq(users.id, f.memberId));
        expect(
          await validateAccessToken(db, f.grants.get(f.memberId)!.accessToken),
        ).toBeNull();
        await expect(
          refreshAccessToken(db, {
            applicationId: f.applicationId,
            refreshToken: f.grants.get(f.memberId)!.refreshToken,
          }),
        ).rejects.toThrow("Invalid refresh token");
      });
    });

    test("inactive retained clients cannot refresh grants", async () => {
      await withFixture(async (f) => {
        await deleteProfile(f.authorId);
        await db
          .update(oauthApplications)
          .set({ active: false })
          .where(eq(oauthApplications.id, f.applicationId));
        expect(
          await validateAccessToken(db, f.grants.get(f.memberId)!.accessToken),
        ).toBeNull();
        await expect(
          refreshAccessToken(db, {
            applicationId: f.applicationId,
            refreshToken: f.grants.get(f.memberId)!.refreshToken,
          }),
        ).rejects.toThrow("Invalid refresh token");
      });
    });

    test("expired and revoked grants remain invalid after author deletion", async () => {
      await withFixture(async (f) => {
        await deleteProfile(f.authorId);
        await db
          .update(oauthAccessTokens)
          .set({
            expiresAt: "2000-01-01T00:00:00.000Z",
            refreshTokenExpiresAt: "2000-01-01T00:00:00.000Z",
          })
          .where(
            and(
              eq(oauthAccessTokens.applicationId, f.applicationId),
              eq(oauthAccessTokens.userId, f.memberId),
            ),
          );
        expect(
          await validateAccessToken(db, f.grants.get(f.memberId)!.accessToken),
        ).toBeNull();
        await expect(
          refreshAccessToken(db, {
            applicationId: f.applicationId,
            refreshToken: f.grants.get(f.memberId)!.refreshToken,
          }),
        ).rejects.toThrow("Refresh token expired");
        await db
          .update(oauthAccessTokens)
          .set({ revoked: true })
          .where(
            and(
              eq(oauthAccessTokens.applicationId, f.applicationId),
              eq(oauthAccessTokens.userId, f.survivorId),
            ),
          );
        expect(
          await validateAccessToken(
            db,
            f.grants.get(f.survivorId)!.accessToken,
          ),
        ).toBeNull();
      });
    });

    test("explicit application deletion still cascades all grants, including other-team consumers", async () => {
      await withFixture(async (f) => {
        await deleteProfile(f.authorId);
        expect(
          await deleteOAuthApplication(db, {
            id: f.applicationId,
            teamId: f.teamId,
          }),
        ).toMatchObject({ id: f.applicationId });
        expect(await grantsForApplication(f)).toEqual({
          tokens: [],
          codes: [],
        });
        expect(
          await getOAuthApplicationById(
            db,
            f.controlApplicationId,
            f.consumerTeamId,
          ),
        ).toMatchObject({ id: f.controlApplicationId });
      });
    });

    test("deleting the owning team still removes its client and every associated grant", async () => {
      await withFixture(async (f) => {
        await deleteProfile(f.authorId);
        await deleteTeam(db, { teamId: f.teamId, userId: f.survivorId });
        expect(await application(f)).toBeUndefined();
        expect(await grantsForApplication(f)).toEqual({
          tokens: [],
          codes: [],
        });
        expect(
          await getOAuthApplicationById(
            db,
            f.controlApplicationId,
            f.consumerTeamId,
          ),
        ).toMatchObject({ id: f.controlApplicationId });
      });
    });
  },
);
