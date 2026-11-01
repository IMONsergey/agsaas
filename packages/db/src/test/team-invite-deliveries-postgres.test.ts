import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  claimTeamInviteDelivery,
  getTeamInviteDelivery,
  listRecoverableTeamInviteDeliveries,
  prepareTeamInviteDelivery,
  recordTeamInviteDeliveryOutcome,
} from "../queries/team-invite-deliveries";
import {
  acceptTeamInvite,
  createTeamInvites,
  deleteTeamInvite,
  getTeamInvites,
} from "../queries/user-invites";
import {
  teamInviteDeliveries,
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

describe.skipIf(!isTestDatabaseAvailable())(
  "durable team invitation delivery (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);
    async function withFixture(
      run: (f: {
        teamId: string;
        otherTeamId: string;
        owner: string;
        member: string;
        invitee: string;
        recipient: string;
      }) => Promise<void>,
    ) {
      const f = {
        teamId: randomUUID(),
        otherTeamId: randomUUID(),
        owner: randomUUID(),
        member: randomUUID(),
        invitee: randomUUID(),
        recipient: "",
      };
      f.recipient = `${f.invitee}@example.test`;
      try {
        await db.insert(teams).values(
          [f.teamId, f.otherTeamId].map((id) => ({
            id,
            inboxId: id,
            name: "Invitation fixture",
          })),
        );
        await db.insert(users).values(
          [f.owner, f.member, f.invitee].map((id) => ({
            id,
            email: `${id}@example.test`,
            fullName: "Fixture person",
            teamId: id === f.invitee ? f.otherTeamId : f.teamId,
          })),
        );
        await db.insert(usersOnTeam).values([
          { teamId: f.teamId, userId: f.owner, role: "owner" },
          { teamId: f.teamId, userId: f.member, role: "member" },
          { teamId: f.otherTeamId, userId: f.invitee, role: "owner" },
        ]);
        await run(f);
      } finally {
        await db
          .delete(teams)
          .where(inArray(teams.id, [f.teamId, f.otherTeamId]));
        await db
          .delete(users)
          .where(inArray(users.id, [f.owner, f.member, f.invitee]));
      }
    }
    type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];
    async function create(
      f: Fixture,
      role: "owner" | "member" = "member",
      actorId = f.owner,
    ) {
      const data = await createTeamInvites(db, {
        teamId: f.teamId,
        actorId,
        invites: [{ email: f.recipient, role, invitedBy: actorId }],
      });
      const row = data.results[0];
      if (!row) throw new Error("Fixture invitation missing");
      return { teamId: f.teamId, inviteId: row.id, deliveryId: row.deliveryId };
    }
    const body = (recipient: string, html = "<p>Join the team</p>") =>
      JSON.stringify({
        from: "AGSaaS <hello@example.test>",
        to: [recipient],
        subject: "Invitation",
        html,
      });

    test("creates invitation and durable intent together, with no Redis dependency", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        const row = await getTeamInviteDelivery(db, scope);
        expect(row).toMatchObject({
          teamId: f.teamId,
          inviteId: scope.inviteId,
          status: "pending",
          recipient: f.recipient,
          attempts: 0,
          envelope: null,
        });
        expect(row?.context).toMatchObject({
          invitedByEmail: `${f.owner}@example.test`,
          teamName: "Invitation fixture",
          locale: "en",
        });
        expect(await listRecoverableTeamInviteDeliveries(db)).toContainEqual(
          scope,
        );
      });
    });
    test("a delivery insert failure rolls back the invitation too", async () => {
      await withFixture(async (f) => {
        await db.transaction(async (tx) => {
          // Transaction-local trigger and fixture only; no changes survive this test.
          await tx.execute(
            sql`CREATE FUNCTION pg_temp.reject_invite_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture delivery failure'; END $$`,
          );
          await tx.execute(
            sql`CREATE TRIGGER fixture_reject_invite_delivery BEFORE INSERT ON public.team_invite_deliveries FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_invite_delivery()`,
          );
          try {
            await expect(
              createTeamInvites(tx as unknown as Database, {
                teamId: f.teamId,
                actorId: f.owner,
                invites: [
                  { email: f.recipient, role: "member", invitedBy: f.owner },
                ],
              }),
            ).rejects.toThrow();
            expect(
              await tx
                .select()
                .from(userInvites)
                .where(eq(userInvites.teamId, f.teamId)),
            ).toHaveLength(0);
          } finally {
            await tx.execute(
              sql`DROP TRIGGER fixture_reject_invite_delivery ON public.team_invite_deliveries`,
            );
          }
        });
      });
    });
    test("concurrent repeated creation persists one invitation and one delivery", async () => {
      await withFixture(async (f) => {
        const input = {
          teamId: f.teamId,
          actorId: f.owner,
          invites: [
            { email: f.recipient, role: "member" as const, invitedBy: f.owner },
          ],
        };
        const results = await Promise.all([
          createTeamInvites(db, input),
          createTeamInvites(db, input),
        ]);
        expect(results.reduce((n, r) => n + r.results.length, 0)).toBe(1);
        expect(
          await db
            .select()
            .from(teamInviteDeliveries)
            .where(eq(teamInviteDeliveries.teamId, f.teamId)),
        ).toHaveLength(1);
      });
    });
    test("mixed owner/member batch from a member creates neither invitations nor intents", async () => {
      await withFixture(async (f) => {
        await expect(
          createTeamInvites(db, {
            teamId: f.teamId,
            actorId: f.member,
            invites: [
              { email: f.recipient, role: "member", invitedBy: f.owner },
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
        expect(
          await db
            .select()
            .from(teamInviteDeliveries)
            .where(eq(teamInviteDeliveries.teamId, f.teamId)),
        ).toHaveLength(0);
      });
    });
    test("normalizes duplicates and reports every skipped input", async () => {
      await withFixture(async (f) => {
        const r = await createTeamInvites(db, {
          teamId: f.teamId,
          actorId: f.member,
          invites: [
            {
              email: ` ${f.recipient.toUpperCase()} `,
              role: "member",
              invitedBy: f.owner,
            },
            { email: f.recipient, role: "member", invitedBy: f.owner },
          ],
        });
        expect(r.results).toHaveLength(1);
        expect(r.skippedInvites).toEqual([
          { email: f.recipient, reason: "duplicate" },
        ]);
      });
    });
    test("deleting actors cannot create new durable invitations", async () => {
      await withFixture(async (f) => {
        await db
          .update(users)
          .set({ deletionStartedAt: sql`statement_timestamp()` })
          .where(eq(users.id, f.owner));
        await expect(create(f)).rejects.toThrow();
        expect(
          await db
            .select()
            .from(userInvites)
            .where(eq(userInvites.teamId, f.teamId)),
        ).toHaveLength(0);
      });
    });
    test("a body is frozen once and cannot be replaced on retry", async () => {
      await withFixture(async (f) => {
        const scope = await create(f),
          first = body(f.recipient);
        await prepareTeamInviteDelivery(db, scope, first);
        await prepareTeamInviteDelivery(
          db,
          scope,
          body(f.recipient, "<p>Changed template</p>"),
        );
        expect((await getTeamInviteDelivery(db, scope))?.envelope).toBe(first);
      });
    });
    test("a wrong recipient cannot become the persisted provider envelope", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        await expect(
          prepareTeamInviteDelivery(db, scope, body("other@example.test")),
        ).rejects.toThrow();
        expect((await getTeamInviteDelivery(db, scope))?.envelope).toBeNull();
      });
    });
    test("a pending intent cannot be claimed before its exact body is frozen", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        expect((await claimTeamInviteDelivery(db, scope)).state).toBe(
          "unprepared",
        );
        expect((await getTeamInviteDelivery(db, scope))?.attempts).toBe(0);
      });
    });
    test("concurrent claims produce a single sending lease", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        await prepareTeamInviteDelivery(db, scope, body(f.recipient));
        const results = await Promise.all([
          claimTeamInviteDelivery(db, scope),
          claimTeamInviteDelivery(db, scope),
        ]);
        expect(results.map((r) => r.state).sort()).toEqual(["busy", "claimed"]);
        expect((await getTeamInviteDelivery(db, scope))?.attempts).toBe(1);
      });
    });
    test("tenant scope is enforced on lookup, preparation, claim and outcome", async () => {
      await withFixture(async (f) => {
        const scope = await create(f),
          other = { ...scope, teamId: f.otherTeamId };
        expect(await getTeamInviteDelivery(db, other)).toBeNull();
        expect(
          await prepareTeamInviteDelivery(db, other, body(f.recipient)),
        ).toBeNull();
        expect((await claimTeamInviteDelivery(db, other)).state).toBe(
          "missing",
        );
        expect(
          await recordTeamInviteDeliveryOutcome(
            db,
            { ...other, leaseToken: randomUUID() },
            { kind: "accepted", messageId: "message-other" },
          ),
        ).toBeNull();
        await expect(
          db
            .update(teamInviteDeliveries)
            .set({ teamId: f.otherTeamId })
            .where(eq(teamInviteDeliveries.id, scope.deliveryId))
            .execute(),
        ).rejects.toThrow();
      });
    });
    test("provider acceptance is durable, purges the envelope and never claims another send", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        await prepareTeamInviteDelivery(db, scope, body(f.recipient));
        const claim = await claimTeamInviteDelivery(db, scope);
        if (claim.state !== "claimed") throw new Error("Fixture claim missing");
        const accepted = await recordTeamInviteDeliveryOutcome(
          db,
          { ...scope, leaseToken: claim.leaseToken },
          { kind: "accepted", messageId: "message-001" },
        );
        expect(accepted).toMatchObject({
          status: "accepted",
          providerMessageId: "message-001",
          envelope: null,
          attempts: 1,
        });
        expect(accepted?.acceptedAt).not.toBeNull();
        expect((await claimTeamInviteDelivery(db, scope)).state).toBe(
          "accepted",
        );
        expect(
          await listRecoverableTeamInviteDeliveries(db),
        ).not.toContainEqual(scope);
        const publicRows = await getTeamInvites(db, f.teamId);
        expect(publicRows[0]?.delivery).toMatchObject({ status: "accepted" });
        expect(JSON.stringify(publicRows)).not.toContain(
          "<p>Join the team</p>",
        );
      });
    });
    test("stale lease outcomes cannot replace a newer sender's receipt", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        await prepareTeamInviteDelivery(db, scope, body(f.recipient));
        const claim = await claimTeamInviteDelivery(db, scope);
        if (claim.state !== "claimed") throw new Error("Fixture claim missing");
        expect(
          await recordTeamInviteDeliveryOutcome(
            db,
            { ...scope, leaseToken: randomUUID() },
            { kind: "accepted", messageId: "wrong" },
          ),
        ).toBeNull();
        expect((await getTeamInviteDelivery(db, scope))?.status).toBe(
          "sending",
        );
      });
    });
    test("transient outcomes keep the same body but defer recovery", async () => {
      await withFixture(async (f) => {
        const scope = await create(f),
          envelope = body(f.recipient);
        await prepareTeamInviteDelivery(db, scope, envelope);
        const claim = await claimTeamInviteDelivery(db, scope);
        if (claim.state !== "claimed") throw new Error("Fixture claim missing");
        const retried = await recordTeamInviteDeliveryOutcome(
          db,
          { ...scope, leaseToken: claim.leaseToken },
          { kind: "retry", code: "provider_uncertain" },
        );
        expect(retried).toMatchObject({
          status: "pending",
          envelope,
          attempts: 1,
          lastError: "provider_uncertain",
        });
        expect((await claimTeamInviteDelivery(db, scope)).state).toBe("busy");
      });
    });
    test("removing an invitation stops all unstarted delivery and stale outcomes", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        await prepareTeamInviteDelivery(db, scope, body(f.recipient));
        await deleteTeamInvite(db, {
          id: scope.inviteId,
          teamId: f.teamId,
          actorId: f.member,
        });
        expect((await claimTeamInviteDelivery(db, scope)).state).toBe(
          "missing",
        );
        expect(await getTeamInviteDelivery(db, scope)).toBeNull();
      });
    });
    test("accepting an invitation creates one membership and cancels pending mail", async () => {
      await withFixture(async (f) => {
        const scope = await create(f);
        await acceptTeamInvite(db, {
          id: scope.inviteId,
          userId: f.invitee,
          userEmail: f.recipient,
        });
        expect(await getTeamInviteDelivery(db, scope)).toBeNull();
        expect(
          await db
            .select()
            .from(usersOnTeam)
            .where(
              and(
                eq(usersOnTeam.teamId, f.teamId),
                eq(usersOnTeam.userId, f.invitee),
              ),
            ),
        ).toHaveLength(1);
      });
    });
    test("removing or demoting the inviter before a first send cancels unauthorized owner invitations", async () => {
      await withFixture(async (f) => {
        const scope = await create(f, "owner");
        await prepareTeamInviteDelivery(db, scope, body(f.recipient));
        await db
          .update(usersOnTeam)
          .set({ role: "member" })
          .where(
            and(
              eq(usersOnTeam.teamId, f.teamId),
              eq(usersOnTeam.userId, f.owner),
            ),
          );
        const claim = await claimTeamInviteDelivery(db, scope);
        expect(claim.state).toBe("stopped");
        expect(claim.delivery).toMatchObject({
          status: "canceled",
          lastError: "invitation_changed",
          attempts: 0,
        });
      });
    });
    for (const [name, patch, code] of [
      [
        "expired provider replay window",
        {
          createdAt: sql`clock_timestamp()-interval '25 hours'`,
          firstAttemptAt: sql`clock_timestamp()-interval '24 hours'`,
          updatedAt: sql`clock_timestamp()`,
        },
        "replay_window_expired",
      ],
      [
        "attempt limit",
        {
          firstAttemptAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
          attempts: 12,
        },
        "attempt_limit",
      ],
      [
        "clock regression",
        { updatedAt: sql`clock_timestamp()+interval '1 hour'` },
        "clock_anomaly",
      ],
    ] as const) {
      test(`${name} stops automatic sends`, async () => {
        await withFixture(async (f) => {
          const scope = await create(f);
          await prepareTeamInviteDelivery(db, scope, body(f.recipient));
          await db
            .update(teamInviteDeliveries)
            .set(patch)
            .where(eq(teamInviteDeliveries.id, scope.deliveryId));
          const claim = await claimTeamInviteDelivery(db, scope);
          expect(claim.state).toBe("stopped");
          expect(claim.delivery).toMatchObject({
            status: "reconciliation",
            lastError: code,
          });
        });
      });
    }
    test("legacy pending invitations have unknown delivery and are never backfilled by recovery", async () => {
      await withFixture(async (f) => {
        const id = randomUUID();
        await db.insert(userInvites).values({
          id,
          teamId: f.teamId,
          email: f.recipient,
          role: "member",
          invitedBy: f.owner,
          code: randomUUID(),
        });
        expect((await getTeamInvites(db, f.teamId))[0]?.delivery).toBeNull();
        expect(
          (await listRecoverableTeamInviteDeliveries(db)).some(
            (s) => s.inviteId === id,
          ),
        ).toBe(false);
      });
    });
  },
);
