import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database, TransactionClient } from "../client";
import {
  recordInvoiceEmailAccepted,
  recordInvoiceReminderAccepted,
} from "../queries/invoice-delivery";
import { customers, invoices, teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const acceptedAt = "2026-10-31T12:00:00.000Z";
const earlierAt = "2026-10-31T11:00:00.000Z";
const laterAt = "2026-10-31T13:00:00.000Z";
const rollback = Symbol("invoice delivery fixtures always roll back");
type Fixture = { invoiceId: string; teamId: string; otherTeamId: string };

// Real PostgreSQL, only under the shared guard for an explicitly configured
// local/disposable midday_test database. No truncation, DDL, external providers
// or committed fixtures. These tests prove current-row SQL semantics, while
// worker tests separately exercise a payment during an in-flight provider call.
describe.skipIf(!isTestDatabaseAvailable())(
  "invoice email acknowledgement (PostgreSQL rollback fixtures)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withFixture(
      run: (tx: TransactionClient, fixture: Fixture) => Promise<void>,
    ) {
      try {
        await db.transaction(async (tx) => {
          const teamId = randomUUID();
          const otherTeamId = randomUUID();
          const invoiceId = randomUUID();
          const customerId = randomUUID();
          await tx.insert(teams).values([
            { id: teamId, name: "Invoice delivery fixture", inboxId: teamId },
            {
              id: otherTeamId,
              name: "Other delivery fixture",
              inboxId: otherTeamId,
            },
          ]);
          await tx.insert(customers).values({
            id: customerId,
            teamId,
            name: "Delivery customer",
            email: "customer@example.test",
          });
          await tx.insert(invoices).values({
            id: invoiceId,
            teamId,
            customerId,
            amount: 100,
            currency: "RUB",
            status: "draft",
            invoiceNumber: `delivery-${invoiceId}`,
          });
          await run(tx, { invoiceId, teamId, otherTeamId });
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    }

    for (const status of ["draft", "scheduled"] as const) {
      test(`${status} becomes unpaid only after provider acceptance`, async () => {
        await withFixture(async (tx, fixture) => {
          await tx
            .update(invoices)
            .set({ status, scheduledJobId: "invoices:scheduled-fixture" })
            .where(eq(invoices.id, fixture.invoiceId));
          const result = await recordInvoiceEmailAccepted(tx, {
            ...fixture,
            acceptedAt,
            recipient: "customer@example.test",
          });
          expect(result?.status).toBe("unpaid");
          expect(new Date(result!.sentAt!).toISOString()).toBe(acceptedAt);
          expect(result?.sentTo).toBe("customer@example.test");
          const [stored] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, fixture.invoiceId));
          expect(stored?.scheduledJobId).toBe(
            status === "scheduled" ? null : "invoices:scheduled-fixture",
          );
        });
      });
    }

    for (const status of [
      "paid",
      "canceled",
      "refunded",
      "overdue",
      "unpaid",
    ] as const) {
      test(`a status changed to ${status} during HTTP is never regressed`, async () => {
        await withFixture(async (tx, fixture) => {
          // This is the stale observation a worker took before awaiting HTTP.
          const [observed] = await tx
            .select({ status: invoices.status })
            .from(invoices)
            .where(eq(invoices.id, fixture.invoiceId));
          expect(observed?.status).toBe("draft");
          // A payment/cancellation/refund update occurred before the response.
          await tx
            .update(invoices)
            .set({
              status,
              paidAt: earlierAt,
              scheduledJobId: "invoices:preserve-fixture",
            })
            .where(eq(invoices.id, fixture.invoiceId));
          const result = await recordInvoiceEmailAccepted(tx, {
            ...fixture,
            acceptedAt,
            recipient: "customer@example.test",
          });
          expect(result?.status).toBe(status);
          expect(new Date(result!.sentAt!).toISOString()).toBe(acceptedAt);
          const [stored] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, fixture.invoiceId));
          expect(stored?.amount).toBe(100);
          expect(stored?.scheduledJobId).toBe("invoices:preserve-fixture");
          expect(new Date(stored!.paidAt!).toISOString()).toBe(earlierAt);
        });
      });
    }

    test("matching scheduled acceptance transitions to unpaid and clears only its own marker", async () => {
      await withFixture(async (tx, fixture) => {
        const expectedScheduledJobId = "invoices:expected-version";
        await tx
          .update(invoices)
          .set({ status: "scheduled", scheduledJobId: expectedScheduledJobId })
          .where(eq(invoices.id, fixture.invoiceId));
        const result = await recordInvoiceEmailAccepted(tx, {
          ...fixture,
          acceptedAt,
          recipient: "customer@example.test",
          expectedScheduledJobId,
        });
        expect(result?.status).toBe("unpaid");
        expect(result?.scheduledJobId).toBeNull();
        expect(new Date(result!.sentAt!).toISOString()).toBe(acceptedAt);
      });
    });

    for (const current of [
      { status: "scheduled", scheduledJobId: "invoices:newer-version" },
      { status: "scheduled", scheduledJobId: null },
      { status: "draft", scheduledJobId: null },
      { status: "draft", scheduledJobId: "invoices:expected-version" },
      { status: "paid", scheduledJobId: "invoices:expected-version" },
      { status: "canceled", scheduledJobId: "invoices:expected-version" },
      { status: "refunded", scheduledJobId: "invoices:expected-version" },
    ] as const) {
      test(`an in-flight old acceptance records the fact but preserves ${current.status}/${current.scheduledJobId}`, async () => {
        await withFixture(async (tx, fixture) => {
          await tx
            .update(invoices)
            .set(current)
            .where(eq(invoices.id, fixture.invoiceId));
          const result = await recordInvoiceEmailAccepted(tx, {
            ...fixture,
            acceptedAt,
            recipient: "customer@example.test",
            expectedScheduledJobId: "invoices:expected-version",
          });
          expect(result?.status).toBe(current.status);
          expect(result?.scheduledJobId).toBe(current.scheduledJobId);
          expect(new Date(result!.sentAt!).toISOString()).toBe(acceptedAt);
          expect(result?.sentTo).toBe("customer@example.test");
        });
      });
    }

    test("out-of-order completions cannot overwrite a newer recipient or acceptance time", async () => {
      await withFixture(async (tx, fixture) => {
        await recordInvoiceEmailAccepted(tx, {
          ...fixture,
          acceptedAt: laterAt,
          recipient: "new@example.test",
        });
        const older = await recordInvoiceEmailAccepted(tx, {
          ...fixture,
          acceptedAt: earlierAt,
          recipient: "old@example.test",
        });
        expect(new Date(older!.sentAt!).toISOString()).toBe(laterAt);
        expect(older?.sentTo).toBe("new@example.test");
      });
    });

    test("a real reminder acceptance can be recorded after payment without reopening the invoice", async () => {
      await withFixture(async (tx, fixture) => {
        await tx
          .update(invoices)
          .set({ status: "paid", paidAt: earlierAt })
          .where(eq(invoices.id, fixture.invoiceId));
        const first = await recordInvoiceReminderAccepted(tx, {
          ...fixture,
          acceptedAt: laterAt,
        });
        expect(first?.status).toBe("paid");
        expect(new Date(first!.reminderSentAt!).toISOString()).toBe(laterAt);
        const older = await recordInvoiceReminderAccepted(tx, {
          ...fixture,
          acceptedAt: earlierAt,
        });
        expect(older?.status).toBe("paid");
        expect(new Date(older!.reminderSentAt!).toISOString()).toBe(laterAt);
      });
    });

    test("both acknowledgement writes reject another tenant and leave the row untouched", async () => {
      await withFixture(async (tx, fixture) => {
        const wrongTenant = {
          ...fixture,
          teamId: fixture.otherTeamId,
          acceptedAt,
        };
        expect(
          await recordInvoiceEmailAccepted(tx, {
            ...wrongTenant,
            recipient: "other@example.test",
          }),
        ).toBeUndefined();
        expect(
          await recordInvoiceReminderAccepted(tx, wrongTenant),
        ).toBeUndefined();
        const [stored] = await tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.id, fixture.invoiceId),
              eq(invoices.teamId, fixture.teamId),
            ),
          );
        expect(stored?.status).toBe("draft");
        expect(stored?.sentAt).toBeNull();
        expect(stored?.sentTo).toBeNull();
        expect(stored?.reminderSentAt).toBeNull();
      });
    });
  },
);
