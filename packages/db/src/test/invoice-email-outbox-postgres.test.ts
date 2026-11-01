import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  Database,
  DatabaseOrTransaction,
  TransactionClient,
} from "../client";
import {
  claimInvoiceEmailDelivery,
  deferInvoiceEmailFinalization,
  finalizeInvoiceEmailDelivery,
  getInvoiceEmailDelivery,
  invoiceEmailEnvelopeHash,
  listRecoverableInvoiceEmailDeliveries,
  prepareInvoiceEmailDelivery,
  recordInvoiceDeliveryOutcome,
} from "../queries/invoice-email-deliveries";
import {
  activities,
  invoiceEmailDeliveries,
  invoices,
  teams,
  users,
  usersOnTeam,
} from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const rollback = Symbol("outbox fixtures always roll back");
const envelope = JSON.stringify({
  from: "sender@example.test",
  to: ["customer@example.test"],
  subject: "Invoice",
  html: "<p>Frozen invoice</p>",
  attachments: [{ content: "UERG", filename: "invoice.pdf" }],
});

async function fixture(db: DatabaseOrTransaction) {
  const teamId = randomUUID();
  const otherTeamId = randomUUID();
  const invoiceId = randomUUID();
  const userId = randomUUID();
  const operationKey = invoiceEmailEnvelopeHash(randomUUID());
  await db.insert(teams).values([
    { id: teamId, name: "Outbox fixture", inboxId: teamId },
    { id: otherTeamId, name: "Foreign outbox fixture", inboxId: otherTeamId },
  ]);
  await db.insert(users).values({
    id: userId,
    teamId,
    fullName: "Fixture owner",
    email: "owner@example.test",
  });
  await db.insert(usersOnTeam).values({ userId, teamId, role: "owner" });
  await db.insert(invoices).values({
    id: invoiceId,
    teamId,
    amount: 10,
    currency: "RUB",
    status: "draft",
    invoiceNumber: `OUTBOX-${invoiceId}`,
  });
  return { teamId, invoiceId, otherTeamId, userId, operationKey };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function preparation(f: Fixture) {
  return {
    ...f,
    kind: "invoice" as const,
    recipient: "customer@example.test",
    envelope,
    activitySnapshot: [
      {
        userId: f.userId,
        priority: 3,
        metadata: { recordId: f.invoiceId, invoiceNumber: "OUTBOX-1" },
      },
    ],
  };
}

describe.skipIf(!isTestDatabaseAvailable())(
  "durable invoice email outbox (real PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withFixture(
      run: (tx: TransactionClient, f: Fixture) => Promise<void>,
    ) {
      try {
        await db.transaction(async (tx) => {
          await run(tx, await fixture(tx));
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    }

    test("an operation keeps the first complete rendered envelope, despite changed retries", async () => {
      await withFixture(async (tx, f) => {
        const first = await prepareInvoiceEmailDelivery(tx, preparation(f));
        const retry = await prepareInvoiceEmailDelivery(tx, {
          ...preparation(f),
          envelope: "different bytes",
          recipient: "changed@example.test",
          activitySnapshot: [],
        });
        expect(retry?.id).toBe(first?.id);
        expect(retry?.envelope).toBe(envelope);
        expect(retry?.recipient).toBe("customer@example.test");
        expect(retry?.envelopeHash).toBe(invoiceEmailEnvelopeHash(envelope));
      });
    });

    test("wrong-tenant reads, preparation and outcome cannot touch an operation", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const foreign = { ...f, teamId: f.otherTeamId };
        expect(await getInvoiceEmailDelivery(tx, foreign)).toBeNull();
        expect((await claimInvoiceEmailDelivery(tx, foreign)).state).toBe(
          "missing",
        );
        await expect(
          prepareInvoiceEmailDelivery(tx, {
            ...preparation(f),
            teamId: f.otherTeamId,
          }),
        ).rejects.toThrow("not found");
        expect(
          await recordInvoiceDeliveryOutcome(
            tx,
            { ...foreign, leaseToken: randomUUID() },
            { kind: "accepted", messageId: "no" },
          ),
        ).toBeNull();
      });
    });

    test("composite FK rejects a cross-tenant row even if application validation is bypassed", async () => {
      await withFixture(async (tx, f) => {
        await expect(
          tx.transaction(async (savepoint) => {
            await savepoint.insert(invoiceEmailDeliveries).values({
              teamId: f.otherTeamId,
              invoiceId: f.invoiceId,
              operationKey: f.operationKey,
              kind: "invoice",
              recipient: "customer@example.test",
              envelope,
              envelopeHash: invoiceEmailEnvelopeHash(envelope),
              activitySnapshot: [],
            });
          }),
        ).rejects.toThrow();
        expect(await getInvoiceEmailDelivery(tx, f)).toBeNull();
      });
    });

    test("one lease owns the send and a stale token cannot acknowledge or release it", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        expect(claim.state).toBe("claimed");
        if (claim.state !== "claimed") throw new Error("Expected claim");
        expect(claim.delivery.firstAttemptAt).not.toBeNull();
        expect(claim.delivery.attempts).toBe(1);
        expect((await claimInvoiceEmailDelivery(tx, f)).state).toBe("busy");
        expect(
          await recordInvoiceDeliveryOutcome(
            tx,
            { ...f, leaseToken: randomUUID() },
            { kind: "accepted", messageId: "wrong" },
          ),
        ).toBeNull();
        expect((await getInvoiceEmailDelivery(tx, f))?.status).toBe("sending");
        const accepted = await recordInvoiceDeliveryOutcome(
          tx,
          { ...f, leaseToken: claim.leaseToken },
          { kind: "accepted", messageId: "provider-1" },
        );
        expect(accepted?.status).toBe("accepted");
        expect(accepted?.providerMessageId).toBe("provider-1");
      });
    });

    test("crash lease expires and reclaims the same envelope without resetting first attempt time", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const first = await claimInvoiceEmailDelivery(tx, f);
        if (first.state !== "claimed") throw new Error("Expected first claim");
        await tx
          .update(invoiceEmailDeliveries)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(invoiceEmailDeliveries.id, first.delivery.id));
        const next = await claimInvoiceEmailDelivery(tx, f);
        expect(next.state).toBe("claimed");
        if (next.state !== "claimed")
          throw new Error("Expected recovery claim");
        expect(next.leaseToken).not.toBe(first.leaseToken);
        expect(next.delivery.firstAttemptAt).toBe(
          first.delivery.firstAttemptAt,
        );
        expect(next.delivery.envelope).toBe(first.delivery.envelope);
        expect(
          await recordInvoiceDeliveryOutcome(
            tx,
            { ...f, leaseToken: first.leaseToken },
            { kind: "accepted", messageId: "late-old" },
          ),
        ).toBeNull();
      });
    });

    test("uncertain retry is delayed and never erases the original replay deadline", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        if (claim.state !== "claimed") throw new Error("Expected claim");
        const deferred = await recordInvoiceDeliveryOutcome(
          tx,
          { ...f, leaseToken: claim.leaseToken },
          { kind: "retry", code: "provider_uncertain" },
        );
        expect(deferred?.firstAttemptAt).toBe(claim.delivery.firstAttemptAt);
        expect(deferred?.status).toBe("pending");
        expect((await claimInvoiceEmailDelivery(tx, f)).state).toBe("busy");
        expect(
          (await listRecoverableInvoiceEmailDeliveries(tx, 100)).some(
            (row) => row.operationKey === f.operationKey,
          ),
        ).toBe(false);
      });
    });

    for (const hours of [23, 25, 100])
      test(`after ${hours}h replay stops instead of issuing a new provider key`, async () => {
        await withFixture(async (tx, f) => {
          await prepareInvoiceEmailDelivery(tx, preparation(f));
          await tx
            .update(invoiceEmailDeliveries)
            .set({
              createdAt: sql`clock_timestamp() - interval '101 hours'`,
              firstAttemptAt: sql`clock_timestamp() - ${hours} * interval '1 hour'`,
              attempts: 1,
            })
            .where(eq(invoiceEmailDeliveries.operationKey, f.operationKey));
          const claim = await claimInvoiceEmailDelivery(tx, f);
          expect(claim.state).toBe("stopped");
          expect(claim.delivery?.status).toBe("reconciliation");
          expect(claim.delivery?.lastError).toBe("replay_window_expired");
          expect(claim.delivery?.attempts).toBe(1);
        });
      });

    test("accepted receipt finalizes invoice and activities once, even after payment", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        if (claim.state !== "claimed") throw new Error("Expected claim");
        await recordInvoiceDeliveryOutcome(
          tx,
          { ...f, leaseToken: claim.leaseToken },
          { kind: "accepted", messageId: "provider-1" },
        );
        await tx
          .update(invoices)
          .set({ status: "paid" })
          .where(eq(invoices.id, f.invoiceId));
        expect((await claimInvoiceEmailDelivery(tx, f)).state).toBe("accepted");
        const first = await finalizeInvoiceEmailDelivery(tx, f);
        const repeat = await finalizeInvoiceEmailDelivery(tx, f);
        expect(first?.status).toBe("completed");
        expect(repeat?.completedAt).toBe(first?.completedAt);
        expect(first?.envelope).toBeNull();
        expect(first?.activitySnapshot).toEqual([]);
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, f.invoiceId));
        expect(invoice?.status).toBe("paid");
        expect(invoice?.sentAt).toBe(first?.acceptedAt);
        expect(
          await tx
            .select()
            .from(activities)
            .where(eq(activities.groupId, first!.id)),
        ).toHaveLength(1);
      });
    });

    test("finalization rollback leaves an accepted receipt available for local-only recovery", async () => {
      await withFixture(async (tx, f) => {
        const row = await prepareInvoiceEmailDelivery(tx, preparation(f));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        if (claim.state !== "claimed") throw new Error("Expected claim");
        await recordInvoiceDeliveryOutcome(
          tx,
          { ...f, leaseToken: claim.leaseToken },
          { kind: "accepted", messageId: "provider-1" },
        );
        await tx
          .update(invoiceEmailDeliveries)
          .set({
            activitySnapshot: [
              { userId: "not-a-uuid", priority: 3, metadata: {} },
            ],
          })
          .where(eq(invoiceEmailDeliveries.id, row!.id));
        await expect(finalizeInvoiceEmailDelivery(tx, f)).rejects.toThrow();
        expect((await getInvoiceEmailDelivery(tx, f))?.status).toBe("accepted");
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, f.invoiceId));
        expect(invoice?.sentAt).toBeNull();
        expect(
          await tx
            .select()
            .from(activities)
            .where(eq(activities.groupId, row!.id)),
        ).toHaveLength(0);
        await tx
          .update(invoiceEmailDeliveries)
          .set({ activitySnapshot: preparation(f).activitySnapshot })
          .where(eq(invoiceEmailDeliveries.id, row!.id));
        expect((await finalizeInvoiceEmailDelivery(tx, f))?.status).toBe(
          "completed",
        );
      });
    });

    test("removed members receive no resurrected activity on recovery", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        if (claim.state !== "claimed") throw new Error("Expected claim");
        await recordInvoiceDeliveryOutcome(
          tx,
          { ...f, leaseToken: claim.leaseToken },
          { kind: "accepted", messageId: "provider-1" },
        );
        await tx
          .delete(usersOnTeam)
          .where(
            and(
              eq(usersOnTeam.userId, f.userId),
              eq(usersOnTeam.teamId, f.teamId),
            ),
          );
        const result = await finalizeInvoiceEmailDelivery(tx, f);
        expect(result?.status).toBe("completed");
        expect(
          await tx
            .select()
            .from(activities)
            .where(eq(activities.groupId, result!.id)),
        ).toHaveLength(0);
      });
    });

    for (const attempted of [false, true])
      test(`superseded schedule ${attempted ? "after uncertainty requires reconciliation" : "before HTTP is canceled"}`, async () => {
        await withFixture(async (tx, f) => {
          await tx
            .update(invoices)
            .set({ status: "scheduled", scheduledJobId: "invoices:old" })
            .where(eq(invoices.id, f.invoiceId));
          await prepareInvoiceEmailDelivery(tx, {
            ...preparation(f),
            expectedScheduledJobId: "invoices:old",
          });
          if (attempted)
            await tx
              .update(invoiceEmailDeliveries)
              .set({
                createdAt: sql`clock_timestamp() - interval '2 minutes'`,
                firstAttemptAt: sql`clock_timestamp() - interval '1 minute'`,
                attempts: 1,
              })
              .where(eq(invoiceEmailDeliveries.operationKey, f.operationKey));
          await tx
            .update(invoices)
            .set({ scheduledJobId: "invoices:new" })
            .where(eq(invoices.id, f.invoiceId));
          const claim = await claimInvoiceEmailDelivery(tx, f);
          expect(claim.state).toBe("stopped");
          expect(claim.delivery?.status).toBe(
            attempted ? "reconciliation" : "canceled",
          );
        });
      });

    test("unknown outcomes cannot exhaustively retry forever", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        await tx
          .update(invoiceEmailDeliveries)
          .set({ firstAttemptAt: sql`clock_timestamp()`, attempts: 12 })
          .where(eq(invoiceEmailDeliveries.operationKey, f.operationKey));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        expect(claim.state).toBe("stopped");
        expect(claim.delivery?.lastError).toBe("attempt_limit");
      });
    });

    for (const changed of [
      "paid",
      "rescheduled",
      "attempt_limit",
      "replay_window_expired",
    ] as const)
      test(`a stopped expired lease retains acceptance authority after ${changed}, but cannot reopen retries`, async () => {
        await withFixture(async (tx, f) => {
          if (changed === "rescheduled")
            await tx
              .update(invoices)
              .set({ status: "scheduled", scheduledJobId: "invoices:old" })
              .where(eq(invoices.id, f.invoiceId));
          await prepareInvoiceEmailDelivery(tx, {
            ...preparation(f),
            ...(changed === "rescheduled"
              ? { expectedScheduledJobId: "invoices:old" }
              : {}),
          });
          const first = await claimInvoiceEmailDelivery(tx, f);
          if (first.state !== "claimed") throw new Error("Expected claim");
          await tx
            .update(invoiceEmailDeliveries)
            .set({
              leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
              ...(changed === "attempt_limit" ? { attempts: 12 } : {}),
              ...(changed === "replay_window_expired"
                ? {
                    createdAt: sql`clock_timestamp() - interval '26 hours'`,
                    firstAttemptAt: sql`clock_timestamp() - interval '25 hours'`,
                  }
                : {}),
            })
            .where(eq(invoiceEmailDeliveries.id, first.delivery.id));
          if (changed === "paid" || changed === "rescheduled")
            await tx
              .update(invoices)
              .set(
                changed === "paid"
                  ? { status: "paid" }
                  : { scheduledJobId: "invoices:new" },
              )
              .where(eq(invoices.id, f.invoiceId));
          const stopped = await claimInvoiceEmailDelivery(tx, f);
          expect(stopped.state).toBe("stopped");
          expect(stopped.delivery?.status).toBe("reconciliation");
          expect(stopped.delivery?.lastError).toBe(
            changed === "paid" || changed === "rescheduled"
              ? "invoice_changed"
              : changed,
          );
          expect(stopped.delivery?.leaseToken).toBe(first.leaseToken);
          expect((await claimInvoiceEmailDelivery(tx, f)).state).toBe(
            "stopped",
          );
          for (const kind of ["retry", "rejected", "reconciliation"] as const)
            expect(
              await recordInvoiceDeliveryOutcome(
                tx,
                { ...f, leaseToken: first.leaseToken },
                { kind, code: "late_non_acceptance" },
              ),
            ).toBeNull();
          expect(
            await recordInvoiceDeliveryOutcome(
              tx,
              { ...f, leaseToken: randomUUID() },
              { kind: "accepted", messageId: "wrong-owner" },
            ),
          ).toBeNull();
          expect(
            (
              await recordInvoiceDeliveryOutcome(
                tx,
                { ...f, leaseToken: first.leaseToken },
                { kind: "accepted", messageId: "late-known-acceptance" },
              )
            )?.status,
          ).toBe("accepted");
          expect((await finalizeInvoiceEmailDelivery(tx, f))?.status).toBe(
            "completed",
          );
          const [invoice] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          if (changed === "paid") expect(invoice?.status).toBe("paid");
          if (changed === "rescheduled")
            expect(invoice).toMatchObject({
              status: "scheduled",
              scheduledJobId: "invoices:new",
            });
        });
      });

    test("a backward clock stops replay but the original in-flight owner can still persist a real receipt", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const first = await claimInvoiceEmailDelivery(tx, f);
        if (first.state !== "claimed") throw new Error("Expected first claim");
        // These timestamps represent an attempt recorded before the DB clock
        // moved backwards. Future lease/due values cannot hide this anomaly.
        await tx
          .update(invoiceEmailDeliveries)
          .set({
            firstAttemptAt: sql`clock_timestamp() + interval '1 hour'`,
            updatedAt: sql`clock_timestamp() + interval '1 hour'`,
            nextAttemptAt: sql`clock_timestamp() + interval '2 hours'`,
            leaseExpiresAt: sql`clock_timestamp() + interval '2 hours'`,
          })
          .where(eq(invoiceEmailDeliveries.id, first.delivery.id));
        expect(
          (await listRecoverableInvoiceEmailDeliveries(tx, 100)).some(
            (row) => row.operationKey === f.operationKey,
          ),
        ).toBe(true);
        const stopped = await claimInvoiceEmailDelivery(tx, f);
        expect(stopped.state).toBe("stopped");
        expect(stopped.delivery?.lastError).toBe("clock_anomaly");
        expect(stopped.delivery?.attempts).toBe(1);
        expect(
          await recordInvoiceDeliveryOutcome(
            tx,
            { ...f, leaseToken: first.leaseToken },
            { kind: "retry", code: "provider_uncertain" },
          ),
        ).toBeNull();
        expect(
          await recordInvoiceDeliveryOutcome(
            tx,
            { ...f, leaseToken: randomUUID() },
            { kind: "accepted", messageId: "wrong-owner" },
          ),
        ).toBeNull();
        expect(
          (
            await recordInvoiceDeliveryOutcome(
              tx,
              { ...f, leaseToken: first.leaseToken },
              { kind: "accepted", messageId: "known-acceptance" },
            )
          )?.status,
        ).toBe("accepted");
        expect((await finalizeInvoiceEmailDelivery(tx, f))?.status).toBe(
          "completed",
        );
      });
    });

    test("a poison accepted receipt backs off so another pending operation can be recovered", async () => {
      await withFixture(async (tx, f) => {
        await prepareInvoiceEmailDelivery(tx, preparation(f));
        const claim = await claimInvoiceEmailDelivery(tx, f);
        if (claim.state !== "claimed") throw new Error("Expected claim");
        await recordInvoiceDeliveryOutcome(
          tx,
          { ...f, leaseToken: claim.leaseToken },
          { kind: "accepted", messageId: "provider-1" },
        );
        await tx
          .update(invoiceEmailDeliveries)
          .set({ nextAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
          .where(eq(invoiceEmailDeliveries.operationKey, f.operationKey));
        // A fresh confirmed receipt needs no provider replay or delay.
        expect(
          (await listRecoverableInvoiceEmailDeliveries(tx, 100)).some(
            (row) => row.operationKey === f.operationKey,
          ),
        ).toBe(true);
        await deferInvoiceEmailFinalization(tx, f);
        const second = {
          ...f,
          operationKey: invoiceEmailEnvelopeHash(randomUUID()),
        };
        await prepareInvoiceEmailDelivery(tx, preparation(second));
        const due = await listRecoverableInvoiceEmailDeliveries(tx, 100);
        expect(due.some((row) => row.operationKey === f.operationKey)).toBe(
          false,
        );
        expect(
          due.some((row) => row.operationKey === second.operationKey),
        ).toBe(true);
        expect((await getInvoiceEmailDelivery(tx, f))?.status).toBe("accepted");
      });
    });

    test("two independent PG connections cannot acquire one operation simultaneously", async () => {
      // Only this test commits generated fixtures to allow true concurrent sessions.
      // The guarded disposable DB is mandatory; cleanup targets these exact UUIDs.
      const f = await fixture(db);
      try {
        await prepareInvoiceEmailDelivery(db, preparation(f));
        const claims = await Promise.all([
          claimInvoiceEmailDelivery(db, f),
          claimInvoiceEmailDelivery(db, f),
        ]);
        expect(claims.map((claim) => claim.state).sort()).toEqual([
          "busy",
          "claimed",
        ]);
      } finally {
        await db.delete(users).where(eq(users.id, f.userId));
        await db
          .delete(teams)
          .where(inArray(teams.id, [f.teamId, f.otherTeamId]));
      }
    });
  },
);
