import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database, TransactionClient } from "../client";
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
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeAccessToken,
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
  seedTestProfiles,
  removeTestProfiles,
} from "./helpers/profile-fixture";
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
          await seedTestProfiles(
            tx,
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
        // Retention ledgers deliberately survive their source rows; remove only
        // these generated fixture identities after their assertions finish.
        const fixtureTeams = sql.join(
          [f.teamId, f.consumerTeamId].map((id) => sql`${id}::uuid`),
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
          .delete(teams)
          .where(inArray(teams.id, [f.teamId, f.consumerTeamId]));
        await db.delete(users).where(inArray(users.id, userIds));
        await removeTestProfiles(db, userIds);
      }
    }

    function failGrantInsert(database: Database): Database {
      return new Proxy(database, {
        get(target, key, receiver) {
          if (key === "transaction") {
            return (run: (tx: TransactionClient) => Promise<unknown>) =>
              target.transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(transaction, operation, txReceiver) {
                      if (operation === "insert") {
                        return () => {
                          throw new Error("fixture grant insert failed");
                        };
                      }
                      const value = Reflect.get(
                        transaction,
                        operation,
                        txReceiver,
                      );
                      return typeof value === "function"
                        ? value.bind(transaction)
                        : value;
                    },
                  }),
                ),
              );
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }

    async function grantsFor(f: Fixture, userId = f.memberId) {
      return db
        .select()
        .from(oauthAccessTokens)
        .where(
          and(
            eq(oauthAccessTokens.applicationId, f.applicationId),
            eq(oauthAccessTokens.userId, userId),
          ),
        );
    }

    async function freshCode(f: Fixture, verifier?: string) {
      return (await createAuthorizationCode(db, {
        applicationId: f.applicationId,
        userId: f.memberId,
        teamId: f.teamId,
        scopes: ["invoices.read"],
        redirectUri: "https://example.test/callback",
        codeChallenge: verifier
          ? createHash("sha256").update(verifier).digest("base64url")
          : undefined,
      }))!;
    }

    test("concurrent authorization-code exchanges consume once and commit replay revocation", async () => {
      await withFixture(async (f) => {
        const code = await freshCode(f, "fixture-pkce-verifier");
        const before = await grantsFor(f);
        const results = await Promise.allSettled(
          [1, 2].map(() =>
            exchangeAuthorizationCode(
              db,
              code.code,
              "https://example.test/callback",
              f.applicationId,
              "fixture-pkce-verifier",
            ),
          ),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const after = await grantsFor(f);
        expect(after).toHaveLength(before.length + 1);
        expect(after.every((grant) => grant.revoked)).toBe(true);
        const [storedCode] = await db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.id, code.id));
        expect(storedCode?.used).toBe(true);
      });
    });

    test("a failed grant insert rolls auth-code consumption back and allows a valid retry", async () => {
      await withFixture(async (f) => {
        const code = await freshCode(f);
        await expect(
          exchangeAuthorizationCode(
            failGrantInsert(db),
            code.code,
            "https://example.test/callback",
            f.applicationId,
          ),
        ).rejects.toThrow("fixture grant insert failed");
        const [storedCode] = await db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.id, code.id));
        expect(storedCode?.used).toBe(false);
        const grant = await exchangeAuthorizationCode(
          db,
          code.code,
          "https://example.test/callback",
          f.applicationId,
        );
        expect(await validateAccessToken(db, grant.accessToken)).not.toBeNull();
      });
    });

    test("wrong PKCE or removed membership cannot consume a code or revoke an existing grant", async () => {
      await withFixture(async (f) => {
        const code = await freshCode(f, "correct-fixture-verifier");
        const existing = f.grants.get(f.memberId)!;
        await expect(
          exchangeAuthorizationCode(
            db,
            code.code,
            "https://example.test/callback",
            f.applicationId,
            "wrong-verifier",
          ),
        ).rejects.toThrow("Invalid code verifier");
        expect(
          await validateAccessToken(db, existing.accessToken),
        ).not.toBeNull();
        await db
          .delete(usersOnTeam)
          .where(
            and(
              eq(usersOnTeam.userId, f.memberId),
              eq(usersOnTeam.teamId, f.teamId),
            ),
          );
        await expect(
          exchangeAuthorizationCode(
            db,
            code.code,
            "https://example.test/callback",
            f.applicationId,
            "correct-fixture-verifier",
          ),
        ).rejects.toThrow("Invalid authorization code");
        const [storedCode] = await db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.id, code.id));
        expect(storedCode?.used).toBe(false);
      });
    });

    test("concurrent refreshes yield one replacement and one rejection", async () => {
      await withFixture(async (f) => {
        const existing = f.grants.get(f.memberId)!;
        const before = await grantsFor(f);
        const results = await Promise.allSettled(
          [1, 2].map(() =>
            refreshAccessToken(db, {
              applicationId: f.applicationId,
              refreshToken: existing.refreshToken,
            }),
          ),
        );
        const successful = results.filter(
          (result) => result.status === "fulfilled",
        );
        expect(successful).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        expect(await grantsFor(f)).toHaveLength(before.length + 1);
        expect(await validateAccessToken(db, existing.accessToken)).toBeNull();
        const winner = successful[0]!;
        if (winner.status !== "fulfilled")
          throw new Error("Expected one replacement");
        expect(
          await validateAccessToken(db, winner.value.accessToken),
        ).not.toBeNull();
      });
    });

    test("a failed refresh replacement insert preserves the old grant for retry", async () => {
      await withFixture(async (f) => {
        const existing = f.grants.get(f.memberId)!;
        await expect(
          refreshAccessToken(failGrantInsert(db), {
            applicationId: f.applicationId,
            refreshToken: existing.refreshToken,
          }),
        ).rejects.toThrow("fixture grant insert failed");
        expect(
          await validateAccessToken(db, existing.accessToken),
        ).not.toBeNull();
        const replacement = await refreshAccessToken(db, {
          applicationId: f.applicationId,
          refreshToken: existing.refreshToken,
        });
        expect(
          await validateAccessToken(db, replacement.accessToken),
        ).not.toBeNull();
        expect(await validateAccessToken(db, existing.accessToken)).toBeNull();
      });
    });

    for (const tokenType of ["accessToken", "refreshToken"] as const) {
      test(
        "revocation accepts " + tokenType + " and preserves client binding",
        async () => {
          await withFixture(async (f) => {
            const existing = f.grants.get(f.memberId)!;
            expect(
              await revokeAccessToken(db, {
                applicationId: f.controlApplicationId,
                token: existing[tokenType],
              }),
            ).toBeUndefined();
            expect(
              await validateAccessToken(db, existing.accessToken),
            ).not.toBeNull();
            expect(
              await revokeAccessToken(db, {
                applicationId: f.applicationId,
                token: existing[tokenType],
              }),
            ).toBeDefined();
            expect(
              await validateAccessToken(db, existing.accessToken),
            ).toBeNull();
            await expect(
              refreshAccessToken(db, {
                applicationId: f.applicationId,
                refreshToken: existing.refreshToken,
              }),
            ).rejects.toThrow("Invalid refresh token");
            expect(
              await revokeAccessToken(db, {
                applicationId: f.applicationId,
                token: existing[tokenType],
              }),
            ).toBeUndefined();
          });
        },
      );
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
