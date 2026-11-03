import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { BillingSubscriptionEventError } from "../billing-subscription";
import type { Database } from "../client";
import { applyBillingSubscriptionEvent } from "../queries/billing-subscriptions";
import {
  beginNotificationDispatch,
  finishNotificationDispatch,
  listRecoverableNotificationDispatches,
  notificationDispatchOperationKey,
} from "../queries/notification-dispatches";
import { notificationDispatches, teams, usersOnTeam } from "../schema";
import {
  removeTestProfiles,
  seedTestProfiles,
} from "./helpers/profile-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const products = [
  { id: "own-starter", plan: "starter" as const },
  { id: "own-pro", plan: "pro" as const },
];

describe.skipIf(!isTestDatabaseAvailable())(
  "ordered Polar subscription transitions (PostgreSQL)",
  () => {
    let db: Database;
    let teamId: string;
    let otherTeamId: string;
    let ownerId: string;
    let otherOwnerId: string;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      teamId = randomUUID();
      otherTeamId = randomUUID();
      ownerId = randomUUID();
      otherOwnerId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(teams).values(
          [teamId, otherTeamId].map((id) => ({
            id,
            inboxId: id,
            name: "Billing fixture",
          })),
        );
        await seedTestProfiles(tx, [
          {
            id: ownerId,
            teamId,
            fullName: "Billing owner",
            email: `${ownerId}@owner.example.test`,
          },
          {
            id: otherOwnerId,
            teamId: otherTeamId,
            fullName: "Other owner",
            email: `${otherOwnerId}@other.example.test`,
          },
        ]);
        await tx.insert(usersOnTeam).values([
          { userId: ownerId, teamId, role: "owner" },
          { userId: otherOwnerId, teamId: otherTeamId, role: "owner" },
        ]);
      });
    });
    afterEach(async () => {
      await db.transaction(async (tx) => {
        await tx.delete(teams).where(inArray(teams.id, [teamId, otherTeamId]));
        await removeTestProfiles(tx, [ownerId, otherOwnerId]);
      });
    });
    afterAll(closeDatabase);

    function event(
      id: string,
      minute: number,
      type = "subscription.active",
      changes: Record<string, unknown> = {},
    ) {
      return {
        type,
        data: {
          id,
          createdAt: new Date("2026-11-01T09:00:00.000Z"),
          modifiedAt: new Date(Date.UTC(2026, 10, 1, 10, minute)),
          productId: "own-pro",
          status: "active",
          cancelAtPeriodEnd: false,
          customerId: "customer-fixture",
          customer: {
            id: "customer-fixture",
            externalId: teamId,
            email: "billing@example.test",
          },
          metadata: { teamId },
          ...changes,
        },
      };
    }
    const apply = (value: unknown) =>
      applyBillingSubscriptionEvent(db, { event: value, products });
    const notices = () =>
      db
        .select()
        .from(notificationDispatches)
        .where(eq(notificationDispatches.teamId, teamId));
    async function current(id = teamId) {
      const [team] = await db
        .select({
          plan: teams.plan,
          subscriptionStatus: teams.subscriptionStatus,
          canceledAt: teams.canceledAt,
          billingSubscriptionId: teams.billingSubscriptionId,
          billingSubscriptionCreatedAt: teams.billingSubscriptionCreatedAt,
          billingUpdatedAt: teams.billingUpdatedAt,
          email: teams.email,
        })
        .from(teams)
        .where(eq(teams.id, id));
      return team!;
    }

    test("establishes a verified trial, upgrades the same subscription and ignores duplicate/older versions", async () => {
      expect(
        (
          await apply(
            event("subscription-one", 1, "subscription.created", {
              status: "trialing",
              productId: "own-starter",
            }),
          )
        ).state,
      ).toBe("applied");
      expect(await current()).toMatchObject({
        plan: "starter",
        subscriptionStatus: "trialing",
        billingSubscriptionId: "subscription-one",
      });
      expect((await apply(event("subscription-one", 3))).state).toBe("applied");
      const activated = await current();
      expect(activated).toMatchObject({
        plan: "pro",
        subscriptionStatus: "active",
        canceledAt: null,
      });
      expect(
        (
          await apply(
            event("subscription-one", 2, "subscription.active", {
              productId: "own-starter",
            }),
          )
        ).state,
      ).toBe("stale");
      expect((await apply(event("subscription-one", 3))).state).toBe("stale");
      expect(await current()).toEqual(activated);
    });

    test("old subscription events cannot roll back its replacement or poison its version clock", async () => {
      await apply(
        event("old-subscription", 1, "subscription.active", {
          productId: "own-starter",
        }),
      );
      await apply(
        event("new-subscription", 10, "subscription.active", {
          createdAt: new Date("2026-11-01T09:10:00.000Z"),
        }),
      );
      const replacement = await current();
      expect((await apply(event("old-subscription", 2))).state).toBe("stale");
      expect((await apply(event("old-subscription", 30))).state).toBe("stale");
      expect(await current()).toEqual(replacement);
      for (const [type, status] of [
        ["subscription.canceled", "canceled"],
        ["subscription.past_due", "past_due"],
        ["subscription.revoked", "canceled"],
      ]) {
        expect(
          (await apply(event("old-subscription", 20, type, { status }))).state,
        ).toBe("foreign_subscription");
        expect(await current()).toEqual(replacement);
      }
      expect(
        (
          await apply(
            event("new-subscription", 11, "subscription.active", {
              createdAt: new Date("2026-11-01T09:10:00.000Z"),
            }),
          )
        ).state,
      ).toBe("applied");
      expect(await current(otherTeamId)).toMatchObject({
        plan: "trial",
        billingSubscriptionId: null,
        billingUpdatedAt: null,
      });
    });

    test("cancellation keeps current access until revocation and retains a tombstone afterward", async () => {
      await apply(event("current-subscription", 1));
      await apply(
        event("current-subscription", 2, "subscription.canceled", {
          cancelAtPeriodEnd: true,
        }),
      );
      expect(await current()).toMatchObject({
        plan: "pro",
        subscriptionStatus: "active",
      });
      expect((await current()).canceledAt).not.toBeNull();
      await apply(
        event("current-subscription", 3, "subscription.revoked", {
          status: "past_due",
        }),
      );
      expect(await current()).toMatchObject({
        plan: "pro",
        subscriptionStatus: "past_due",
      });
      await apply(
        event("current-subscription", 4, "subscription.revoked", {
          status: "canceled",
        }),
      );
      const revoked = await current();
      expect(revoked).toMatchObject({
        plan: "trial",
        subscriptionStatus: null,
        billingSubscriptionId: "current-subscription",
      });
      expect((await apply(event("current-subscription", 2))).state).toBe(
        "stale",
      );
      expect(await current()).toEqual(revoked);
    });

    test("replacement uses immutable resource age, not modification timestamps across subscriptions", async () => {
      await apply(
        event("older-recovered-subscription", 30, "subscription.active", {
          productId: "own-starter",
        }),
      );
      expect(
        (
          await apply(
            event("newer-subscription", 20, "subscription.active", {
              createdAt: new Date("2026-11-01T09:10:00.000Z"),
            }),
          )
        ).state,
      ).toBe("applied");
      expect(await current()).toMatchObject({
        plan: "pro",
        billingSubscriptionId: "newer-subscription",
      });
      expect(
        (await apply(event("older-recovered-subscription", 40))).state,
      ).toBe("stale");
      expect(await current()).toMatchObject({
        plan: "pro",
        billingSubscriptionId: "newer-subscription",
      });
    });

    test("equal creation time for different subscriptions is ambiguous; one resource's creation time cannot change", async () => {
      await apply(event("bound-subscription", 1));
      const bound = await current();
      expect(
        (
          await apply(
            event("ambiguous-subscription", 20, "subscription.active", {
              productId: "own-starter",
            }),
          )
        ).state,
      ).toBe("ambiguous_subscription");
      await expect(
        apply(
          event("bound-subscription", 2, "subscription.active", {
            createdAt: new Date("2026-11-01T09:01:00.000Z"),
          }),
        ),
      ).rejects.toThrow(BillingSubscriptionEventError);
      expect(await current()).toEqual(bound);
    });

    test("rejects missing versions, foreign products and customer/team binding mismatches without mutation", async () => {
      const original = await current();
      for (const change of [
        { id: null },
        { createdAt: undefined },
        { createdAt: null },
        { createdAt: "2026-11-01T09:00:00.000Z" },
        { createdAt: new Date("invalid") },
        { createdAt: new Date("2026-11-01T12:00:00.000Z") },
        { modifiedAt: null },
        { modifiedAt: "2026-11-01T10:01:00.000Z" },
        { modifiedAt: new Date("invalid") },
        { productId: "another-installation-product" },
        { metadata: { teamId: otherTeamId } },
        { customer: { id: "customer-fixture", externalId: otherTeamId } },
        { customer: { id: "different-customer", externalId: teamId } },
        { customer: { id: "customer-fixture" } },
      ]) {
        await expect(
          apply(event("subscription-one", 1, "subscription.active", change)),
        ).rejects.toThrow(BillingSubscriptionEventError);
        expect(await current()).toEqual(original);
      }
      expect(await current(otherTeamId)).toMatchObject({
        plan: "trial",
        billingSubscriptionId: null,
      });
    });

    for (const first of ["subscription.canceled", "subscription.revoked"]) {
      test(`same-version terminal cancellation and revocation revoke access when ${first} arrives first`, async () => {
        await apply(event("current-subscription", 1));
        const second =
          first === "subscription.canceled"
            ? "subscription.revoked"
            : "subscription.canceled";
        expect(
          (
            await apply(
              event("current-subscription", 2, first, { status: "canceled" }),
            )
          ).state,
        ).toBe("applied");
        expect(
          (
            await apply(
              event("current-subscription", 2, second, { status: "canceled" }),
            )
          ).state,
        ).toBe("stale");
        expect(await current()).toMatchObject({
          plan: "trial",
          subscriptionStatus: null,
          billingSubscriptionId: "current-subscription",
        });
      });
    }

    for (const first of ["subscription.canceled", "subscription.active"]) {
      test(`same-version scheduled cancellation reflects recovered access when ${first} arrives first`, async () => {
        await apply(event("current-subscription", 1));
        await apply(
          event("current-subscription", 2, "subscription.past_due", {
            status: "past_due",
          }),
        );
        const second =
          first === "subscription.canceled"
            ? "subscription.active"
            : "subscription.canceled";
        const snapshot = {
          status: "active",
          cancelAtPeriodEnd: true,
          productId: "own-starter",
        };
        expect(
          (await apply(event("current-subscription", 3, first, snapshot)))
            .state,
        ).toBe("applied");
        expect(
          (await apply(event("current-subscription", 3, second, snapshot)))
            .state,
        ).toBe("stale");
        expect(await current()).toMatchObject({
          plan: "starter",
          subscriptionStatus: "active",
          billingSubscriptionId: "current-subscription",
        });
        expect(new Date((await current()).canceledAt!).toISOString()).toBe(
          "2026-11-01T10:03:00.000Z",
        );
      });
    }

    test("does not infer a legacy paid subscription ID from a cancellation", async () => {
      await db
        .update(teams)
        .set({ plan: "pro", subscriptionStatus: "active" })
        .where(eq(teams.id, teamId));
      expect(
        (
          await apply(
            event("unknown-legacy-subscription", 1, "subscription.revoked", {
              status: "canceled",
            }),
          )
        ).state,
      ).toBe("foreign_subscription");
      expect(await current()).toMatchObject({
        plan: "pro",
        subscriptionStatus: "active",
        billingSubscriptionId: null,
        billingUpdatedAt: null,
      });
      const absent = randomUUID();
      expect(
        (
          await apply(
            event("missing-team", 1, "subscription.active", {
              metadata: { teamId: absent },
              customer: { id: "customer-fixture", externalId: absent },
            }),
          )
        ).state,
      ).toBe("missing");
    });

    test("concurrent subscription versions converge on the latest provider resource", async () => {
      await Promise.all(
        [8, 3, 1, 7, 4, 2, 6, 5].map((minute) =>
          apply(
            event(`subscription-${minute}`, minute, "subscription.active", {
              productId: minute === 8 ? "own-pro" : "own-starter",
              createdAt: new Date(Date.UTC(2026, 10, 1, 9, minute)),
            }),
          ),
        ),
      );
      const team = await current();
      expect(team).toMatchObject({
        plan: "pro",
        subscriptionStatus: "active",
        billingSubscriptionId: "subscription-8",
      });
      expect(new Date(team.billingUpdatedAt!).toISOString()).toBe(
        "2026-11-01T10:08:00.000Z",
      );
    });

    test("a delayed revocation rechecks the subscription ID after a real replacement row lock", async () => {
      await apply(event("old-subscription", 1));
      const concurrent: {
        pending?: Promise<{ error: unknown; state?: string }>;
        result?: { error: unknown; state?: string };
      } = {};
      try {
        await db.transaction(async (tx) => {
          await applyBillingSubscriptionEvent(tx, {
            event: event("new-subscription", 10, "subscription.active", {
              createdAt: new Date("2026-11-01T09:10:00.000Z"),
            }),
            products,
          });
          const owner = await tx.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
          );
          const pid = owner.rows[0]!.pid;
          concurrent.pending = apply(
            event("old-subscription", 20, "subscription.revoked", {
              status: "canceled",
            }),
          ).then(
            (result) => ({ error: null, state: result.state }),
            (error: unknown) => ({ error }),
          );
          const deadline = Date.now() + 2_000;
          let blocked = false;
          while (Date.now() < deadline) {
            const locks = await db.execute<{ blocked: boolean }>(
              sql`select exists(select 1 from pg_stat_activity where ${pid}::integer = any(pg_blocking_pids(pid))) as blocked`,
            );
            if (locks.rows[0]?.blocked) {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          // COMMIT replacement before the old subscription's UPDATE may resume.
        });
      } finally {
        concurrent.result = await concurrent.pending;
      }
      if (concurrent.result?.error) throw concurrent.result.error;
      expect(concurrent.result?.state).toBe("foreign_subscription");
      const team = await current();
      expect(team).toMatchObject({
        plan: "pro",
        subscriptionStatus: "active",
        billingSubscriptionId: "new-subscription",
      });
      expect(new Date(team.billingUpdatedAt!).toISOString()).toBe(
        "2026-11-01T10:10:00.000Z",
      );
    });

    test("a payment issue atomically retains one frozen owner notice without a Redis job", async () => {
      await apply(event("current-subscription", 1));
      const value = event("current-subscription", 2, "subscription.past_due", {
        status: "past_due",
      });
      expect((await apply(value)).state).toBe("applied");
      const [notice] = await notices();
      expect(notice).toBeDefined();
      const operation = createHash("sha256")
        .update(`current-subscription\0${value.data.modifiedAt.toISOString()}`)
        .digest("hex");
      const sourceJobId = `payment-issue-${teamId}-${operation}`;
      expect(notice).toMatchObject({
        kind: "payment-issue",
        sourceJobId,
        operationKey: notificationDispatchOperationKey(
          "payment-issue",
          sourceJobId,
        ),
        status: "pending",
        attempts: 0,
        startedAt: null,
        payload: {
          teamId,
          email: `${ownerId}@owner.example.test`,
          fullName: "Billing owner",
          teamName: "Billing fixture",
        },
      });
      expect(
        (await listRecoverableNotificationDispatches(db)).some(
          (row) => row.id === notice!.id,
        ),
      ).toBe(true);
      expect(
        await db
          .select()
          .from(notificationDispatches)
          .where(eq(notificationDispatches.teamId, otherTeamId)),
      ).toHaveLength(0);
      await db
        .update(users)
        .set({ email: "changed-owner@example.test", fullName: "Changed name" })
        .where(eq(users.id, ownerId));
      expect((await apply(value)).state).toBe("stale");
      const rows = await notices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(notice!.id);
      expect(rows[0]?.payload).toEqual(notice!.payload);
      expect(rows[0]?.payloadHash).toBe(notice!.payloadHash);
    });

    test("an identical stale delivery preserves a completed receipt and never recreates its payload", async () => {
      await apply(event("current-subscription", 1));
      const value = event("current-subscription", 2, "subscription.past_due", {
        status: "past_due",
      });
      await apply(value);
      const [notice] = await notices();
      const scope = { teamId, operationKey: notice!.operationKey };
      const claim = await beginNotificationDispatch(db, scope, true);
      if (claim.state !== "claimed")
        throw new Error("Fixture notice was not claimed");
      await finishNotificationDispatch(
        db,
        { ...scope, token: claim.token },
        {
          activities: 0,
          sent: 1,
          skipped: 0,
          failed: 0,
          uncertain: 0,
          retryable: false,
          providerMessageIds: ["fixture-acceptance-no-real-send"],
        },
      );
      expect((await apply(value)).state).toBe("stale");
      const rows = await notices();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: notice!.id,
        status: "completed",
        payload: null,
        attempts: 1,
      });
    });

    test("failure to retain an intent rolls back the entitlement version and permits the same event retry", async () => {
      await apply(event("current-subscription", 1));
      const original = await current();
      await db
        .update(users)
        .set({ fullName: "x".repeat(300_000) })
        .where(eq(users.id, ownerId));
      const value = event("current-subscription", 2, "subscription.past_due", {
        status: "past_due",
      });
      await expect(apply(value)).rejects.toThrow(
        "notification intent could not be retained",
      );
      expect(await current()).toEqual(original);
      expect(await notices()).toHaveLength(0);
      await db
        .update(users)
        .set({ fullName: "Billing owner" })
        .where(eq(users.id, ownerId));
      expect((await apply(value)).state).toBe("applied");
      expect(await notices()).toHaveLength(1);
    });

    test("an unavailable owner recipient cannot silently commit a payment issue without recovery", async () => {
      await apply(event("current-subscription", 1));
      const original = await current();
      await db.update(users).set({ email: null }).where(eq(users.id, ownerId));
      const value = event("current-subscription", 2, "subscription.past_due", {
        status: "past_due",
      });
      await expect(apply(value)).rejects.toThrow(
        "notice recipient is unavailable",
      );
      expect(await current()).toEqual(original);
      expect(await notices()).toHaveLength(0);
      await db
        .update(users)
        .set({ email: `${ownerId}@owner.example.test` })
        .where(eq(users.id, ownerId));
      expect((await apply(value)).state).toBe("applied");
      expect(await notices()).toHaveLength(1);
    });

    for (const first of ["subscription.canceled", "subscription.past_due"]) {
      test(`same-version past-due snapshot retains one notice when ${first} arrives first`, async () => {
        await apply(event("current-subscription", 1));
        const second =
          first === "subscription.canceled"
            ? "subscription.past_due"
            : "subscription.canceled";
        const state = { status: "past_due", cancelAtPeriodEnd: true };
        expect(
          (await apply(event("current-subscription", 2, first, state))).state,
        ).toBe("applied");
        expect(
          (await apply(event("current-subscription", 2, second, state))).state,
        ).toBe("stale");
        expect(await notices()).toHaveLength(1);
      });
    }

    test("an enclosing rollback removes entitlement and notice, using the same transaction's owner snapshot", async () => {
      await apply(event("current-subscription", 1));
      const original = await current();
      await expect(
        db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({ email: "uncommitted-owner@example.test" })
            .where(eq(users.id, ownerId));
          await applyBillingSubscriptionEvent(tx, {
            event: event("current-subscription", 2, "subscription.past_due", {
              status: "past_due",
            }),
            products,
          });
          const [notice] = await tx
            .select()
            .from(notificationDispatches)
            .where(eq(notificationDispatches.teamId, teamId));
          expect(notice?.payload?.email).toBe("uncommitted-owner@example.test");
          expect(
            (await listRecoverableNotificationDispatches(db)).some(
              (row) => row.id === notice!.id,
            ),
          ).toBe(false);
          throw new Error("fixture rollback");
        }),
      ).rejects.toThrow("fixture rollback");
      expect(await current()).toEqual(original);
      expect(await notices()).toHaveLength(0);
    });
    test("updated plan and uncanceled state are ordered; repeated past-due metadata creates no duplicate notice", async () => {
      await apply(event("current-subscription", 1));
      await apply(
        event("current-subscription", 2, "subscription.updated", {
          productId: "own-starter",
          cancelAtPeriodEnd: true,
        }),
      );
      expect(await current()).toMatchObject({
        plan: "starter",
        subscriptionStatus: "active",
      });
      await apply(
        event("current-subscription", 3, "subscription.uncanceled", {
          productId: "own-starter",
        }),
      );
      expect((await current()).canceledAt).toBeNull();
      await apply(
        event("current-subscription", 4, "subscription.updated", {
          status: "past_due",
        }),
      );
      await apply(
        event("current-subscription", 5, "subscription.updated", {
          status: "past_due",
        }),
      );
      expect(await notices()).toHaveLength(1);
      expect(
        (
          await apply(
            event("current-subscription", 2, "subscription.updated", {
              cancelAtPeriodEnd: true,
            }),
          )
        ).state,
      ).toBe("stale");
      expect((await current()).canceledAt).toBeNull();
    });
    test("reconciliation cannot restore a subscription replaced during the provider GET", async () => {
      await apply(event("new-subscription", 4));
      const result = await applyBillingSubscriptionEvent(db, {
        event: event("old-subscription", 9, "subscription.updated"),
        products,
        expectedBinding: { teamId, subscriptionId: "old-subscription" },
      });
      expect(result.state).toBe("foreign_subscription");
      expect((await current()).billingSubscriptionId).toBe("new-subscription");
    });
  },
);
