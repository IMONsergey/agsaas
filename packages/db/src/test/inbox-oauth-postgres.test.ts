import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { upsertInboxAccount } from "../queries/inbox-accounts";
import {
  consumeInboxOAuthIntent,
  createInboxOAuthIntent,
} from "../queries/inbox-oauth-intents";
import {
  inboxAccounts,
  inboxOAuthIntents,
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

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Fixture = {
  teamId: string;
  otherTeamId: string;
  actorId: string;
  outsiderId: string;
  externalId: string;
};

describe.skipIf(!isTestDatabaseAvailable())(
  "browser inbox OAuth intents (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function fixture(run: (f: Fixture) => Promise<void>) {
      const f = {
        teamId: randomUUID(),
        otherTeamId: randomUUID(),
        actorId: randomUUID(),
        outsiderId: randomUUID(),
        externalId: randomUUID(),
      };
      try {
        await db.insert(teams).values(
          [f.teamId, f.otherTeamId].map((id) => ({
            id,
            inboxId: id,
            name: "Inbox OAuth fixture",
          })),
        );
        await db.transaction((tx) =>
          seedTestProfiles(
            tx,
            [f.actorId, f.outsiderId].map((id) => ({
              id,
              fullName: "Inbox OAuth fixture",
              email: `${id}@example.test`,
              teamId: f.teamId,
            })),
          ),
        );
        await db.insert(usersOnTeam).values(
          [f.teamId, f.otherTeamId].map((teamId) => ({
            teamId,
            userId: f.actorId,
            role: "owner" as const,
          })),
        );
        await run(f);
      } finally {
        await db
          .delete(teams)
          .where(inArray(teams.id, [f.teamId, f.otherTeamId]));
        await db
          .delete(users)
          .where(inArray(users.id, [f.actorId, f.outsiderId]));
        await removeTestProfiles(db, [f.actorId, f.outsiderId]);
      }
    }

    async function start(
      f: Fixture,
      options: { provider?: "gmail" | "outlook"; userId?: string } = {},
    ) {
      const params = {
        stateHash: digest(randomUUID()),
        browserNonceHash: digest(randomUUID()),
        userId: options.userId ?? f.actorId,
        teamId: f.teamId,
        provider: options.provider ?? "gmail",
        source: "inbox" as const,
        aal: "aal1" as const,
        redirectPath: "/inbox",
      };
      await createInboxOAuthIntent(db, params);
      return params;
    }

    function account(
      f: Fixture,
      options: {
        teamId?: string;
        actorId?: string;
        provider?: "gmail" | "outlook";
        accessToken?: string;
      } = {},
    ) {
      return {
        actorUserId: options.actorId ?? f.actorId,
        teamId: options.teamId ?? f.teamId,
        provider: options.provider ?? "gmail",
        externalId: f.externalId,
        email: `${f.externalId}@example.test`,
        accessToken: options.accessToken ?? "encrypted-access-fixture",
        refreshToken: "encrypted-refresh-fixture",
        lastAccessed: new Date().toISOString(),
        expiryDate: "2099-01-01T00:00:00.000Z",
      };
    }

    test("durable intent binds actor/team/provider and exactly one concurrent callback wins", async () => {
      await fixture(async (f) => {
        const params = await start(f);
        const rows = await db
          .select()
          .from(inboxOAuthIntents)
          .where(eq(inboxOAuthIntents.stateHash, params.stateHash));
        expect(rows).toHaveLength(1);
        expect(
          new Date(rows[0]!.expiresAt).getTime() -
            new Date(rows[0]!.createdAt).getTime(),
        ).toBe(600_000);
        const results = await Promise.all([
          consumeInboxOAuthIntent(db, params),
          consumeInboxOAuthIntent(db, params),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)).toMatchObject({
          userId: f.actorId,
          teamId: f.teamId,
          provider: "gmail",
        });
        expect(await consumeInboxOAuthIntent(db, params)).toBeNull();
        expect(
          (
            await db
              .select()
              .from(inboxOAuthIntents)
              .where(eq(inboxOAuthIntents.stateHash, params.stateHash))
          )[0]!.consumedAt,
        ).not.toBeNull();
      });
    });

    test("wrong browser digest or provider does not consume a valid handshake", async () => {
      await fixture(async (f) => {
        const params = await start(f);
        expect(
          await consumeInboxOAuthIntent(db, {
            ...params,
            browserNonceHash: digest("other-browser"),
          }),
        ).toBeNull();
        expect(
          await consumeInboxOAuthIntent(db, { ...params, provider: "outlook" }),
        ).toBeNull();
        expect(await consumeInboxOAuthIntent(db, params)).not.toBeNull();
      });
    });

    test("expired and legacy non-digest intent values are rejected", async () => {
      await fixture(async (f) => {
        const params = await start(f);
        await db
          .update(inboxOAuthIntents)
          .set({
            createdAt: sql`now() - interval '20 minutes'`,
            expiresAt: sql`now() - interval '10 minutes'`,
          })
          .where(eq(inboxOAuthIntents.stateHash, params.stateHash));
        expect(await consumeInboxOAuthIntent(db, params)).toBeNull();
        await expect(
          createInboxOAuthIntent(db, {
            ...params,
            stateHash: "legacy-raw-state",
          }),
        ).rejects.toThrow();
      });
    });

    test("current membership and pending account deletion are checked at consume", async () => {
      await fixture(async (f) => {
        const params = await start(f);
        await db
          .delete(usersOnTeam)
          .where(
            and(
              eq(usersOnTeam.userId, f.actorId),
              eq(usersOnTeam.teamId, f.teamId),
            ),
          );
        expect(await consumeInboxOAuthIntent(db, params)).toBeNull();
        await expect(start(f)).rejects.toThrow();
        await db
          .insert(usersOnTeam)
          .values({ userId: f.actorId, teamId: f.teamId, role: "owner" });
        await db
          .update(users)
          .set({ deletionStartedAt: new Date().toISOString() })
          .where(eq(users.id, f.actorId));
        expect(await consumeInboxOAuthIntent(db, params)).toBeNull();
        await expect(start(f)).rejects.toThrow();
      });
    });

    test("a nonmember cannot create an intent for an arbitrary team", async () => {
      await fixture(async (f) => {
        await expect(start(f, { userId: f.outsiderId })).rejects.toThrow();
      });
    });

    test("profile removal cascades pending intents", async () => {
      await fixture(async (f) => {
        const params = await start(f);
        await db.delete(users).where(eq(users.id, f.actorId));
        expect(await consumeInboxOAuthIntent(db, params)).toBeNull();
        expect(
          await db
            .select()
            .from(inboxOAuthIntents)
            .where(eq(inboxOAuthIntents.stateHash, params.stateHash)),
        ).toEqual([]);
      });
    });

    test("provider tokens cannot be persisted after revocation during provider HTTP", async () => {
      await fixture(async (f) => {
        const params = await start(f);
        expect(await consumeInboxOAuthIntent(db, params)).not.toBeNull();
        // Models a membership removal while the already-authorized exchange is
        // waiting on a provider. Final persistence has its own locked check.
        await db
          .delete(usersOnTeam)
          .where(
            and(
              eq(usersOnTeam.userId, f.actorId),
              eq(usersOnTeam.teamId, f.teamId),
            ),
          );
        await expect(upsertInboxAccount(db, account(f))).rejects.toThrow();
        expect(
          await db
            .select()
            .from(inboxAccounts)
            .where(eq(inboxAccounts.externalId, f.externalId)),
        ).toEqual([]);
      });
    });

    test("external account conflicts cannot overwrite another team or provider", async () => {
      await fixture(async (f) => {
        const original = await upsertInboxAccount(db, account(f));
        expect(original?.id).toBeTruthy();
        expect(
          await upsertInboxAccount(
            db,
            account(f, {
              teamId: f.otherTeamId,
              accessToken: "foreign-overwrite",
            }),
          ),
        ).toBeUndefined();
        expect(
          await upsertInboxAccount(
            db,
            account(f, {
              provider: "outlook",
              accessToken: "provider-overwrite",
            }),
          ),
        ).toBeUndefined();
        const [unchanged] = await db
          .select()
          .from(inboxAccounts)
          .where(eq(inboxAccounts.id, original!.id));
        expect(unchanged).toMatchObject({
          teamId: f.teamId,
          provider: "gmail",
          accessToken: "encrypted-access-fixture",
        });
        const reconnected = await upsertInboxAccount(
          db,
          account(f, { accessToken: "own-reconnected-token" }),
        );
        expect(reconnected?.id).toBe(original!.id);
        expect(
          (
            await db
              .select()
              .from(inboxAccounts)
              .where(eq(inboxAccounts.id, original!.id))
          )[0]!.accessToken,
        ).toBe("own-reconnected-token");
      });
    });
  },
);
