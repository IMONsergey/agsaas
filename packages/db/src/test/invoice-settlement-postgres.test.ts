import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client";
import { financialRequestHash } from "../financial-job";
import {
  getInvoiceSettlement,
  recordInvoiceSettlement,
  reconcileInvoiceSettlement,
} from "../queries/invoice-settlements";
import {
  applyStripeInvoicePaymentEvent,
  attachInvoicePayment,
  reserveInvoicePayment,
} from "../queries/invoice-payments";
import {
  getInvoiceCommandPreview,
  updateInvoiceWithIntent,
} from "../queries/invoice-commands";
import { getTopRevenueClient } from "../queries/customer-analytics";
import { getCustomers } from "../queries/customers";
import { getInvoiceSummary } from "../queries/invoices";
import {
  financialJobDispatches,
  invoices,
  teams,
  invoicePaymentReservations,
} from "../schema";
import {
  createTenantIsolationFixture,
  removeTenantIsolationFixture,
  type TenantIsolationFixture,
} from "./helpers/tenant-isolation-fixture";
import {
  getTestDatabase,
  closeDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "confirmed settlement journal (isolated PostgreSQL)",
  () => {
    let db: Database;
    let f: TenantIsolationFixture;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      f = await createTenantIsolationFixture(db);
    });
    afterEach(async () => {
      if (f) await removeTenantIsolationFixture(db, f);
    });
    afterAll(closeDatabase);
    const scope = () => ({ invoiceId: f.own.invoiceId, teamId: f.own.teamId });
    function payment(amountMinor = "10000", resource = randomUUID()) {
      return {
        ...scope(),
        operationKey: financialRequestHash(resource),
        kind: "payment" as const,
        amountMinor,
        currency: "usd",
        provider: "manual" as const,
        providerAccountId: f.own.teamId,
        providerResourceId: resource,
        actorId: f.own.userId,
        reason: "Verified fixture transfer",
        occurredAt: "2026-11-01T12:00:00Z",
      };
    }
    const current = async () =>
      (
        await db.select().from(invoices).where(eq(invoices.id, f.own.invoiceId))
      )[0]!;
    async function p0001(query: SQL, expected: string) {
      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(query);
        });
      } catch (error) {
        caught = error;
      }
      const codes: string[] = [];
      const messages: string[] = [];
      for (
        let error = caught;
        error && typeof error === "object";
        error = "cause" in error ? error.cause : undefined
      ) {
        if ("code" in error) codes.push(String(error.code));
        if ("message" in error) messages.push(String(error.message));
      }
      expect(codes).toContain("P0001");
      expect(messages.join(" ")).toContain(expected);
    }
    test("two confirmed partial payments settle exactly once and preserve a frozen invoice", async () => {
      const a = payment("4000"),
        b = payment("6000");
      await Promise.all([
        recordInvoiceSettlement(db, a),
        recordInvoiceSettlement(db, b),
      ]);
      const result = await getInvoiceSettlement(db, scope());
      expect(result.entries).toHaveLength(2);
      expect(result.projection).toMatchObject({
        settledMinor: "10000",
        netSettledMinor: "10000",
        balanceMinor: "0",
        overpaymentMinor: "0",
        status: "paid",
      });
      expect((await current()).documentSnapshot).not.toBeNull();
      expect((await current()).status).toBe("paid");
      const duplicate = await recordInvoiceSettlement(db, a);
      expect(duplicate.replayed).toBe(true);
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(2);
      await expect(
        recordInvoiceSettlement(db, { ...a, amountMinor: "4001" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await getInvoiceSettlement(db, scope())).projection?.netSettledMinor,
      ).toBe("10000");
    });
    test("concurrent refunds cannot spend the same confirmed payment twice", async () => {
      const paid = await recordInvoiceSettlement(db, payment());
      const refunds = [payment("7000"), payment("7000")].map((value) => ({
        ...value,
        kind: "refund" as const,
        paymentId: paid.entry.id,
      }));
      const results = await Promise.allSettled(
        refunds.map((value) => recordInvoiceSettlement(db, value)),
      );
      expect(
        results.filter((value) => value.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((value) => value.status === "rejected"),
      ).toHaveLength(1);
      const result = await getInvoiceSettlement(db, scope());
      expect(result.entries).toHaveLength(2);
      expect(result.projection).toMatchObject({
        refundedMinor: "7000",
        netSettledMinor: "3000",
        balanceMinor: "7000",
        status: "unpaid",
      });
    });
    test("an enclosing failure rolls back money, invoice snapshot/status and durable PDF intent", async () => {
      await expect(
        db.transaction(async (tx) => {
          await recordInvoiceSettlement(tx, payment());
          throw new Error("fixture crash");
        }),
      ).rejects.toThrow("fixture crash");
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(0);
      expect(await current()).toMatchObject({
        status: "draft",
        documentSnapshot: null,
        paidAt: null,
      });
      expect(
        await db
          .select()
          .from(financialJobDispatches)
          .where(eq(financialJobDispatches.teamId, f.own.teamId)),
      ).toHaveLength(0);
    });
    test("foreign invoice/payment/currency and direct mutation cannot change the journal", async () => {
      const paid = await recordInvoiceSettlement(db, payment());
      await expect(
        recordInvoiceSettlement(db, {
          ...payment(),
          teamId: f.other.teamId,
          providerAccountId: f.other.teamId,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        recordInvoiceSettlement(db, { ...payment("1"), currency: "eur" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        recordInvoiceSettlement(db, {
          ...payment("1"),
          kind: "refund",
          paymentId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
      await p0001(
        sql`update invoice_settlement_entries set amount_minor=1 where id=${paid.entry.id}::uuid`,
        "immutable",
      );
      await p0001(
        sql`delete from invoice_settlement_entries where id=${paid.entry.id}::uuid`,
        "immutable",
      );
      await p0001(
        sql`insert into invoice_settlement_entries(id,team_id,invoice_id,operation_key,request_hash,kind,amount_minor,currency,provider,provider_account_id,provider_resource_id,occurred_at,reason)
   select gen_random_uuid(),${f.other.teamId}::uuid,invoice_id,repeat('a',64),repeat('b',64),'payment',1,'usd','manual',${f.other.teamId},'foreign-fixture',clock_timestamp(),'fixture' from invoice_settlement_entries where id=${paid.entry.id}::uuid`,
        "does not belong",
      );
      expect(
        (await getInvoiceSettlement(db, scope())).projection?.netSettledMinor,
      ).toBe("10000");
    });
    test("a refund is limited by its own payment, even when another payment has enough money", async () => {
      const a = await recordInvoiceSettlement(db, payment("4000"));
      await recordInvoiceSettlement(db, payment("6000"));
      await expect(
        recordInvoiceSettlement(db, {
          ...payment("4001"),
          kind: "refund",
          paymentId: a.entry.id,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await getInvoiceSettlement(db, scope())).projection?.refundedMinor,
      ).toBe("0");
    });
    test("projection reconciliation repairs derived state without fabricating ledger history", async () => {
      await recordInvoiceSettlement(db, payment("4000"));
      await db.execute(
        sql`update invoice_settlement_state set projection=jsonb_set(projection,'{balanceMinor}','"1"'::jsonb) where invoice_id=${f.own.invoiceId}::uuid`,
      );
      expect(await reconcileInvoiceSettlement(db, scope())).toMatchObject({
        state: "drift",
        changed: false,
      });
      expect(
        await reconcileInvoiceSettlement(db, { ...scope(), apply: true }),
      ).toMatchObject({
        state: "drift",
        changed: true,
        expected: { balanceMinor: "6000" },
      });
      expect(await reconcileInvoiceSettlement(db, scope())).toMatchObject({
        state: "consistent",
        changed: false,
      });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
    });
    test("legacy paid flags require evidence and the Mark paid action records real manual confirmation", async () => {
      await db
        .update(invoices)
        .set({ status: "paid", paidAt: "2026-11-01T12:00:00Z" })
        .where(eq(invoices.id, f.own.invoiceId));
      expect(await getInvoiceSettlement(db, scope())).toMatchObject({
        projection: null,
        reconciliationRequired: true,
      });
      await expect(
        recordInvoiceSettlement(db, payment()),
      ).rejects.toMatchObject({ status: 409 });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(0);
      await updateInvoiceWithIntent(db, {
        id: f.other.invoiceId,
        teamId: f.other.teamId,
        userId: f.other.userId,
        status: "paid",
      });
      expect(
        (
          await getInvoiceSettlement(db, {
            invoiceId: f.other.invoiceId,
            teamId: f.other.teamId,
          })
        ).projection?.netSettledMinor,
      ).toBe("10000");
    });
    test("partial money invalidates an AI preview even when the invoice remains unpaid", async () => {
      await db
        .update(invoices)
        .set({ status: "unpaid" })
        .where(eq(invoices.id, f.own.invoiceId));
      const a = await getInvoiceCommandPreview(db, {
        id: f.own.invoiceId,
        teamId: f.own.teamId,
      });
      await recordInvoiceSettlement(db, payment("1000"));
      const b = await getInvoiceCommandPreview(db, {
        id: f.own.invoiceId,
        teamId: f.own.teamId,
      });
      expect(a?.status).toBe("unpaid");
      expect(b?.status).toBe("unpaid");
      expect(a?.revision).not.toBe(b?.revision);
    });
    test("manual partial plus Stripe remaining balance, partial refund, late replay and second attempt conserve money", async () => {
      await db
        .update(teams)
        .set({
          stripeAccountId: "acct_fixture",
          stripeConnectStatus: "connected",
        })
        .where(eq(teams.id, f.own.teamId));
      await db
        .update(invoices)
        .set({ template: { paymentEnabled: true, currency: "USD" } })
        .where(eq(invoices.id, f.own.invoiceId));
      await recordInvoiceSettlement(db, payment("4000"));
      const attempt = await reserveInvoicePayment(db, scope());
      expect(attempt.amountMinor).toBe(6000);
      await expect(
        recordInvoiceSettlement(db, payment("1")),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await attachInvoicePayment(db, {
          ...attempt,
          paymentIntentId: "pi_first",
        }),
      ).toBe(true);
      const event = {
        ...scope(),
        reservationId: attempt.id,
        paymentIntentId: "pi_first",
        stripeAccountId: "acct_fixture",
        amountMinor: 6000,
        currency: "usd",
        kind: "paid" as const,
        occurredAt: "2026-11-02T12:00:00Z",
      };
      expect(
        (await applyStripeInvoicePaymentEvent(db, event)).projection,
      ).toMatchObject({
        netSettledMinor: "10000",
        balanceMinor: "0",
        status: "paid",
      });
      const partial = await applyStripeInvoicePaymentEvent(db, {
        ...event,
        kind: "refunded",
        refunds: [{ id: "re_partial", amountMinor: 1500, status: "succeeded" }],
      });
      expect(partial.projection).toMatchObject({
        refundedMinor: "1500",
        netSettledMinor: "8500",
        balanceMinor: "1500",
        status: "unpaid",
      });
      expect(partial.notify).toBe(false);
      const next = await reserveInvoicePayment(db, scope());
      expect(next.id).not.toBe(attempt.id);
      expect(next.amountMinor).toBe(1500);
      await applyStripeInvoicePaymentEvent(db, event);
      expect((await current()).paymentIntentId).toBeNull();
      expect(
        await attachInvoicePayment(db, {
          ...next,
          paymentIntentId: "pi_second",
        }),
      ).toBe(true);
      const final = await applyStripeInvoicePaymentEvent(db, {
        ...event,
        reservationId: next.id,
        paymentIntentId: "pi_second",
        amountMinor: 1500,
      });
      expect(final.projection).toMatchObject({
        settledMinor: "11500",
        refundedMinor: "1500",
        netSettledMinor: "10000",
        balanceMinor: "0",
        status: "paid",
      });
      expect(
        await db
          .select()
          .from(invoicePaymentReservations)
          .where(
            and(
              eq(invoicePaymentReservations.invoiceId, f.own.invoiceId),
              eq(invoicePaymentReservations.state, "settled"),
            ),
          ),
      ).toHaveLength(2);
    });
    test("pending refunds have zero monetary effect and a confirmed failed refund is compensated once", async () => {
      await db
        .update(teams)
        .set({
          stripeAccountId: "acct_fixture",
          stripeConnectStatus: "connected",
        })
        .where(eq(teams.id, f.own.teamId));
      await db
        .update(invoices)
        .set({
          status: "unpaid",
          template: { paymentEnabled: true, currency: "USD" },
        })
        .where(eq(invoices.id, f.own.invoiceId));
      const r = await reserveInvoicePayment(db, scope());
      const event = {
        ...scope(),
        reservationId: r.id,
        paymentIntentId: "pi_refund",
        stripeAccountId: "acct_fixture",
        amountMinor: 10000,
        currency: "usd",
        kind: "refunded" as const,
        occurredAt: "2026-11-02T12:00:00Z",
      };
      expect(
        (
          await applyStripeInvoicePaymentEvent(db, {
            ...event,
            refunds: [
              { id: "re_pending", amountMinor: 2000, status: "pending" },
            ],
          })
        ).projection?.netSettledMinor,
      ).toBe("10000");
      await applyStripeInvoicePaymentEvent(db, {
        ...event,
        refunds: [{ id: "re_pending", amountMinor: 2000, status: "succeeded" }],
      });
      const failed = {
        ...event,
        refunds: [{ id: "re_pending", amountMinor: 2000, status: "failed" }],
      };
      await applyStripeInvoicePaymentEvent(db, failed);
      await applyStripeInvoicePaymentEvent(db, failed);
      const result = await getInvoiceSettlement(db, scope());
      expect(result.entries).toHaveLength(3);
      expect(result.projection).toMatchObject({
        netSettledMinor: "10000",
        refundedMinor: "0",
        status: "paid",
      });
    });
    test("invoice, customer and top-client metrics distinguish billed money from confirmed partial receipts", async () => {
      await db
        .update(invoices)
        .set({ status: "unpaid" })
        .where(eq(invoices.id, f.own.invoiceId));
      expect(
        await getTopRevenueClient(db, { teamId: f.own.teamId }),
      ).toBeNull();
      await recordInvoiceSettlement(db, {
        ...payment("4000"),
        occurredAt: new Date().toISOString(),
      });
      expect(
        await getTopRevenueClient(db, { teamId: f.own.teamId }),
      ).toMatchObject({
        customerId: f.own.customerId,
        totalRevenue: 40,
        invoiceCount: 1,
        currency: "USD",
        incomplete: false,
      });
      expect(
        (await getCustomers(db, { teamId: f.own.teamId })).data.find(
          (row) => row.id === f.own.customerId,
        ),
      ).toMatchObject({ totalRevenue: 40, outstandingAmount: 60 });
      expect(
        await getInvoiceSummary(db, {
          teamId: f.own.teamId,
          statuses: ["unpaid"],
        }),
      ).toMatchObject({ totalAmount: 60, currency: "USD", invoiceCount: 1 });
    });
  },
);
