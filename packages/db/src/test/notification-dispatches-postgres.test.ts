import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import type { NotificationDispatchOutcome } from "../notification-dispatch";
import { createActivity } from "../queries/activities";
import { markUpcomingNotificationSent } from "../queries/invoice-recurring";
import {
  beginNotificationDispatch,
  ensureNotificationDispatch,
  finishNotificationDispatch,
  interruptNotificationDispatch,
  listNotificationDispatchStatus,
  listRecoverableNotificationDispatches,
  notificationDispatchOperationKey,
  stopPendingNotificationDispatch,
} from "../queries/notification-dispatches";
import {
  activities,
  invoiceRecurring,
  notificationDispatches,
  teams,
} from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "generic notification dispatch fencing (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);
    async function fixture(
      run: (teamId: string, foreignTeamId: string) => Promise<void>,
    ) {
      const ids = [randomUUID(), randomUUID()];
      try {
        await db
          .insert(teams)
          .values(
            ids.map((id) => ({ id, inboxId: id, name: "Dispatch fixture" })),
          );
        await run(ids[0]!, ids[1]!);
      } finally {
        await db.delete(teams).where(inArray(teams.id, ids));
      }
    }
    function intent(teamId: string, sourceJobId = randomUUID()) {
      return {
        teamId,
        sourceJobId,
        kind: "notification" as const,
        operationKey: notificationDispatchOperationKey(
          "notification",
          sourceJobId,
        ),
        payload: { type: "invoice_paid", teamId, invoiceId: randomUUID() },
      };
    }
    const accepted = (
      patch: Partial<NotificationDispatchOutcome> = {},
    ): NotificationDispatchOutcome => ({
      activities: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
      uncertain: 0,
      retryable: false,
      providerMessageIds: ["fixture-receipt"],
      ...patch,
    });
    async function due(scope: { teamId: string; operationKey: string }) {
      await db
        .update(notificationDispatches)
        .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
        .where(
          and(
            eq(notificationDispatches.teamId, scope.teamId),
            eq(notificationDispatches.operationKey, scope.operationKey),
          ),
        );
    }
    async function claim(scope: { teamId: string; operationKey: string }) {
      const value = await beginNotificationDispatch(db, scope, true);
      if (value.state !== "claimed")
        throw new Error(`Expected claim, got ${value.state}`);
      return { ...scope, token: value.token };
    }

    test("concurrent intent and claims share one operation, with canonical key order", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        const [a, b] = await Promise.all([
          ensureNotificationDispatch(db, input),
          ensureNotificationDispatch(db, {
            ...input,
            payload: {
              invoiceId: input.payload.invoiceId,
              teamId,
              type: "invoice_paid",
            },
          }),
        ]);
        expect(a.id).toBe(b.id);
        const claims = await Promise.all([
          beginNotificationDispatch(db, input, true),
          beginNotificationDispatch(db, input, true),
        ]);
        expect(claims.map((value) => value.state).sort()).toEqual([
          "busy",
          "claimed",
        ]);
        const rows = await listNotificationDispatchStatus(db, teamId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.attempts).toBe(1);
        await expect(
          ensureNotificationDispatch(db, {
            ...input,
            payload: { ...input.payload, invoiceId: randomUUID() },
          }),
        ).rejects.toThrow("payload conflict");
      }));

    test("missing configuration defers before first dispatch and preserves the recoverable intent", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        const original = await ensureNotificationDispatch(db, input);
        const deferred = await beginNotificationDispatch(db, input, false);
        expect(deferred.state).toBe("pending");
        expect(deferred.row).toMatchObject({
          attempts: 0,
          startedAt: null,
          dispatchToken: null,
          leaseExpiresAt: null,
          lastError: "configuration_unavailable",
          payloadHash: original.payloadHash,
          payload: input.payload,
        });
        expect((await beginNotificationDispatch(db, input, true)).state).toBe(
          "pending",
        );
        await due(input);
        expect(
          (await listRecoverableNotificationDispatches(db)).some(
            (row) => row.id === original.id,
          ),
        ).toBe(true);
        const ready = await beginNotificationDispatch(db, input, true);
        expect(ready.state).toBe("claimed");
        expect(ready.row?.attempts).toBe(1);
      }));

    test("confirmed acceptance is reusable, prunes payload, and does not need configured email", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        await ensureNotificationDispatch(db, input);
        const receipt = await finishNotificationDispatch(
          db,
          await claim(input),
          accepted(),
        );
        if (!receipt) {
          throw new Error("Expected a completed notification dispatch receipt");
        }
        expect(receipt).toMatchObject({
          status: "completed",
          payload: null,
          attempts: 1,
          dispatchToken: null,
        });
        expect((await beginNotificationDispatch(db, input, false)).state).toBe(
          "completed",
        );
        expect((await ensureNotificationDispatch(db, input)).id).toBe(
          receipt.id,
        );
        expect(
          (await listRecoverableNotificationDispatches(db)).some(
            (row) => row.id === receipt.id,
          ),
        ).toBe(false);
      }));

    test("partial and uncertain results are visible reconciliation and never reacquired", async () =>
      fixture(async (teamId) => {
        for (const result of [
          accepted({ failed: 1 }),
          accepted({
            sent: 0,
            failed: 2,
            uncertain: 2,
            providerMessageIds: [],
          }),
        ]) {
          const input = intent(teamId);
          await ensureNotificationDispatch(db, input);
          const finished = await finishNotificationDispatch(
            db,
            await claim(input),
            result,
          );
          expect(finished?.status).toBe("reconciliation");
          expect((await beginNotificationDispatch(db, input, true)).state).toBe(
            "reconciliation",
          );
          expect(finished?.payload).toEqual(input.payload);
        }
        expect(
          (await listNotificationDispatchStatus(db, teamId)).map(
            (row) => row.status,
          ),
        ).toEqual(["reconciliation", "reconciliation"]);
      }));

    test("only a confirmed zero-acceptance transient rejection is retried", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        await ensureNotificationDispatch(db, input);
        const first = await claim(input);
        const rejected = await finishNotificationDispatch(
          db,
          first,
          accepted({
            sent: 0,
            failed: 2,
            retryable: true,
            providerMessageIds: [],
          }),
        );
        expect(rejected).toMatchObject({
          status: "pending",
          attempts: 1,
          dispatchToken: null,
        });
        expect((await beginNotificationDispatch(db, input, true)).state).toBe(
          "pending",
        );
        await due(input);
        const second = await claim(input);
        expect(second.token).not.toBe(first.token);
        expect(
          await finishNotificationDispatch(db, first, accepted()),
        ).toBeNull();
        expect(
          (await finishNotificationDispatch(db, second, accepted()))?.status,
        ).toBe("completed");
      }));

    test("a permanent zero-acceptance rejection stops without claiming completion", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        await ensureNotificationDispatch(db, input);
        const row = await finishNotificationDispatch(
          db,
          await claim(input),
          accepted({ sent: 0, failed: 1, providerMessageIds: [] }),
        );
        expect(row).toMatchObject({
          status: "rejected",
          lastError: "provider_rejected",
        });
        expect((await beginNotificationDispatch(db, input, true)).state).toBe(
          "rejected",
        );
      }));

    test("a crash fence expires to reconciliation, while its late genuine receipt can complete", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        const row = await ensureNotificationDispatch(db, input);
        const fence = await claim(input);
        await db
          .update(notificationDispatches)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(notificationDispatches.id, row.id));
        expect(
          (await listRecoverableNotificationDispatches(db)).some(
            (value) => value.id === row.id,
          ),
        ).toBe(true);
        const stopped = await beginNotificationDispatch(db, input, true);
        expect(stopped).toMatchObject({
          state: "reconciliation",
          row: { attempts: 1, dispatchToken: fence.token },
        });
        expect(
          (await finishNotificationDispatch(db, fence, accepted()))?.status,
        ).toBe("completed");
      }));

    test("explicit interrupted dispatch cannot be automatically sent again", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        await ensureNotificationDispatch(db, input);
        const fence = await claim(input);
        await interruptNotificationDispatch(db, fence);
        expect((await beginNotificationDispatch(db, input, true)).state).toBe(
          "reconciliation",
        );
        expect(
          (await listNotificationDispatchStatus(db, teamId))[0],
        ).toMatchObject({ attempts: 1, lastError: "dispatch_interrupted" });
      }));

    test("foreign team cannot claim or receipt an operation and status hides payload/recipients", async () =>
      fixture(async (teamId, foreignTeamId) => {
        const input = intent(teamId);
        await ensureNotificationDispatch(db, input);
        const fence = await claim(input);
        const foreign = { ...fence, teamId: foreignTeamId };
        expect((await beginNotificationDispatch(db, foreign, true)).state).toBe(
          "missing",
        );
        expect(
          await finishNotificationDispatch(db, foreign, accepted()),
        ).toBeNull();
        await interruptNotificationDispatch(db, foreign);
        expect(await listNotificationDispatchStatus(db, foreignTeamId)).toEqual(
          [],
        );
        const status = (await listNotificationDispatchStatus(db, teamId))[0]!;
        expect(status.status).toBe("dispatching");
        expect(status).not.toHaveProperty("payload");
        expect(status).not.toHaveProperty("outcome");
      }));

    test("invalid payload scope and malformed receipt fail before weakening a fence", async () =>
      fixture(async (teamId, foreignTeamId) => {
        const input = intent(teamId);
        await expect(
          ensureNotificationDispatch(db, {
            ...input,
            payload: { ...input.payload, teamId: foreignTeamId },
          }),
        ).rejects.toThrow("Invalid notification dispatch payload");
        await ensureNotificationDispatch(db, input);
        const fence = await claim(input);
        await expect(
          finishNotificationDispatch(db, fence, accepted({ sent: 2 })),
        ).rejects.toThrow("Invalid notification acceptance receipt");
        expect((await beginNotificationDispatch(db, input, true)).state).toBe(
          "busy",
        );
      }));

    test("clock regression and exhausted safe retries stop instead of sending", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        const row = await ensureNotificationDispatch(db, input);
        await db
          .update(notificationDispatches)
          .set({ updatedAt: sql`clock_timestamp() + interval '1 minute'` })
          .where(eq(notificationDispatches.id, row.id));
        expect(await beginNotificationDispatch(db, input, true)).toMatchObject({
          state: "reconciliation",
          row: { attempts: 0, lastError: "clock_anomaly" },
        });
        const limited = intent(teamId);
        const limitedRow = await ensureNotificationDispatch(db, limited);
        await db
          .update(notificationDispatches)
          .set({ attempts: 12 })
          .where(eq(notificationDispatches.id, limitedRow.id));
        expect(
          await beginNotificationDispatch(db, limited, true),
        ).toMatchObject({
          state: "rejected",
          row: { lastError: "attempt_limit" },
        });
      }));

    test("deterministic in-app identity makes concurrent activity retries insert once", async () =>
      fixture(async (teamId) => {
        const activity = {
          id: randomUUID(),
          teamId,
          type: "invoice_paid" as const,
          source: "system" as const,
          metadata: { invoiceId: randomUUID() },
        };
        const results = await Promise.all([
          createActivity(db, activity),
          createActivity(db, activity),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(
          await db
            .select()
            .from(activities)
            .where(eq(activities.id, activity.id)),
        ).toHaveLength(1);
      }));
    test("expired business event cancels only a pending intent, never an in-flight request", async () =>
      fixture(async (teamId) => {
        const input = intent(teamId);
        await ensureNotificationDispatch(db, input);
        expect(
          (await stopPendingNotificationDispatch(db, input))?.lastError,
        ).toBe("event_expired");
        expect((await beginNotificationDispatch(db, input, true)).state).toBe(
          "rejected",
        );
        const active = intent(teamId);
        await ensureNotificationDispatch(db, active);
        const fence = await claim(active);
        expect(await stopPendingNotificationDispatch(db, active)).toBeNull();
        expect(
          (await finishNotificationDispatch(db, fence, accepted()))?.status,
        ).toBe("completed");
      }));
    test("upcoming marker is tenant-scoped and cannot mark a different recurring occurrence", async () =>
      fixture(async (teamId, foreignTeamId) => {
        const id = randomUUID();
        const first = "2030-01-01T10:00:00.000Z";
        const second = "2030-02-01T10:00:00.000Z";
        await db.insert(invoiceRecurring).values({
          id,
          teamId,
          frequency: "monthly_date",
          endType: "never",
          timezone: "UTC",
          nextScheduledAt: first,
        });
        expect(
          await markUpcomingNotificationSent(db, {
            id,
            teamId: foreignTeamId,
            expectedNextScheduledAt: first,
          }),
        ).toBeUndefined();
        await db
          .update(invoiceRecurring)
          .set({ nextScheduledAt: second })
          .where(eq(invoiceRecurring.id, id));
        expect(
          await markUpcomingNotificationSent(db, {
            id,
            teamId,
            expectedNextScheduledAt: first,
          }),
        ).toBeUndefined();
        const [untouched] = await db
          .select()
          .from(invoiceRecurring)
          .where(eq(invoiceRecurring.id, id));
        expect(untouched?.upcomingNotificationSentAt).toBeNull();
        expect(
          (
            await markUpcomingNotificationSent(db, {
              id,
              teamId,
              expectedNextScheduledAt: second,
            })
          )?.upcomingNotificationSentAt,
        ).not.toBeNull();
      }));
  },
);
