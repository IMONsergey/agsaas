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
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Database } from "../client";
import { financialRequestHash } from "../financial-job";
import { getTopRevenueClient } from "../queries/customer-analytics";
import { getCustomers } from "../queries/customers";
import {
  getInvoiceCommandPreview,
  updateInvoiceWithIntent,
} from "../queries/invoice-commands";
import {
  applyInvoiceProviderReconciliation,
  applyStripeInvoicePaymentEvent,
  attachInvoicePayment,
  getInvoiceProviderReconciliationPlan,
  getInvoiceRefundContext,
  type InvoiceProviderReconciliationPlan,
  type InvoiceProviderReconciliationProof,
  reserveInvoicePayment,
} from "../queries/invoice-payments";
import {
  getInvoiceSettlement,
  reconcileInvoiceSettlement,
  recordInvoiceSettlement,
  requireInvoiceSettlementProviderReconciliation,
} from "../queries/invoice-settlements";
import { getInvoiceSummary } from "../queries/invoices";
import {
  financialJobDispatches,
  invoicePaymentReservations,
  invoices,
  teams,
} from "../schema";
import {
  createTenantIsolationFixture,
  removeTenantIsolationFixture,
  type TenantIsolationFixture,
} from "./helpers/tenant-isolation-fixture";
import {
  closeDatabase,
  getTestDatabase,
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
      ).rejects.toMatchObject({ status: 403 });
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
        await reconcileInvoiceSettlement(db, {
          ...scope(),
          apply: true,
          actorId: f.own.userId,
        }),
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
        refunds: [
          {
            id: "re_pending",
            amountMinor: 2000,
            status: "failed",
            verifiedBy: "resource_get" as const,
            failureBalanceTransactionId: "txn_returnedFixture",
          },
        ],
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

    async function confirmedStripeRefund() {
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
      const reservation = await reserveInvoicePayment(db, scope());
      const suffix = randomUUID().replaceAll("-", "");
      const refund = {
        id: `re_${suffix}`,
        amountMinor: 2000,
        status: "succeeded",
      };
      const event = {
        ...scope(),
        reservationId: reservation.id,
        paymentIntentId: `pi_${suffix}`,
        stripeAccountId: "acct_fixture",
        amountMinor: 10000,
        currency: "usd",
        kind: "refunded" as const,
        occurredAt: "2026-11-02T12:00:00Z",
        refunds: [refund],
      };
      await applyStripeInvoicePaymentEvent(db, event);
      return { event, refund };
    }
    const ownerScope = () => ({ ...scope(), actorId: f.own.userId });
    async function providerPlan() {
      const plan = await getInvoiceProviderReconciliationPlan(db, ownerScope());
      if (!plan)
        throw new Error("Expected a retained provider uncertainty marker");
      return plan;
    }
    function resourceProofs(
      plan: InvoiceProviderReconciliationPlan,
    ): InvoiceProviderReconciliationProof[] {
      return plan.payments.map((payment) => ({
        source: "resource_get",
        paymentIntentId: payment.paymentIntentId,
        stripeAccountId: payment.stripeAccountId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        refunds: payment.refunds.map((refund) => ({
          id: refund.id,
          amountMinor: refund.amountMinor,
          status: refund.reversed ? "failed" : "succeeded",
          verifiedBy: "resource_get",
          failureBalanceTransactionId: refund.reversed
            ? "txn_returnedFixture"
            : null,
        })),
      }));
    }
    for (const anomaly of [
      "missing",
      "pending",
      "requires_action",
      "amount_changed",
    ] as const) {
      test(`a ${anomaly} confirmed-refund observation survives rollback boundaries, paid replay and local rebuild`, async () => {
        const { event, refund } = await confirmedStripeRefund();
        const before = await getInvoiceSettlement(db, scope());
        await expect(
          applyStripeInvoicePaymentEvent(db, {
            ...event,
            refunds:
              anomaly === "missing"
                ? []
                : [
                    {
                      ...refund,
                      amountMinor:
                        anomaly === "amount_changed"
                          ? 1999
                          : refund.amountMinor,
                      status:
                        anomaly === "amount_changed" ? "succeeded" : anomaly,
                    },
                  ],
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(
          (await getInvoiceSettlement(db, scope())).reconciliationRequired,
        ).toBe(true);
        await applyStripeInvoicePaymentEvent(db, {
          ...event,
          kind: "paid",
          refunds: undefined,
        });
        expect(
          await reconcileInvoiceSettlement(db, {
            ...ownerScope(),
            apply: true,
          }),
        ).toMatchObject({ state: "requires_evidence", changed: false });
        const after = await getInvoiceSettlement(db, scope());
        expect(after.entries).toEqual(before.entries);
        expect(after.projection).toEqual(before.projection);
        expect(after.reconciliationRequired).toBe(true);
        expect(after.providerVerificationAvailable).toBe(true);
        await expect(
          recordInvoiceSettlement(db, payment("1")),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          getInvoiceRefundContext(db, scope()),
        ).rejects.toMatchObject({ status: 409 });
        await expect(reserveInvoicePayment(db, scope())).rejects.toMatchObject({
          status: 400,
        });
      });
    }
    test("exact current resource proofs clear uncertainty without inventing money", async () => {
      const { event, refund } = await confirmedStripeRefund();
      await expect(
        applyStripeInvoicePaymentEvent(db, {
          ...event,
          refunds: [{ ...refund, status: "requires_action" }],
        }),
      ).rejects.toMatchObject({ status: 409 });
      const before = await getInvoiceSettlement(db, scope());
      const plan = await providerPlan();
      expect(
        await applyInvoiceProviderReconciliation(db, {
          ...ownerScope(),
          revision: plan.revision,
          proofs: resourceProofs(plan),
        }),
      ).toEqual({ state: "verified", changed: true });
      const after = await getInvoiceSettlement(db, scope());
      expect(after.entries).toEqual(before.entries);
      expect(after.projection).toEqual(before.projection);
      expect(after.reconciliationRequired).toBe(false);
    });
    test("an event arriving during provider GET invalidates even an unchanged monetary snapshot", async () => {
      const { event, refund } = await confirmedStripeRefund();
      const uncertain = {
        ...event,
        refunds: [{ ...refund, status: "pending" }],
      };
      await expect(
        applyStripeInvoicePaymentEvent(db, uncertain),
      ).rejects.toMatchObject({ status: 409 });
      const snapshot = await providerPlan();
      const proofs = resourceProofs(snapshot);
      const before = await getInvoiceSettlement(db, scope());
      await expect(
        applyStripeInvoicePaymentEvent(db, uncertain),
      ).rejects.toMatchObject({ status: 409 });
      expect((await providerPlan()).revision).not.toBe(snapshot.revision);
      await expect(
        applyInvoiceProviderReconciliation(db, {
          ...ownerScope(),
          revision: snapshot.revision,
          proofs,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const after = await getInvoiceSettlement(db, scope());
      expect(after.entries).toEqual(before.entries);
      expect(after.reconciliationRequired).toBe(true);
    });
    test("missing resources, unknown states and cross-account proof never clear the marker", async () => {
      const { event, refund } = await confirmedStripeRefund();
      await expect(
        applyStripeInvoicePaymentEvent(db, {
          ...event,
          refunds: [{ ...refund, status: "pending" }],
        }),
      ).rejects.toMatchObject({ status: 409 });
      const plan = await providerPlan();
      for (const change of [
        "missing",
        "unknown_status",
        "account",
        "amount",
      ] as const) {
        const proofs = resourceProofs(plan);
        if (change === "missing") proofs[0]!.refunds = [];
        if (change === "unknown_status")
          proofs[0]!.refunds[0]!.status = "new_provider_status";
        if (change === "account") proofs[0]!.stripeAccountId = "acct_foreign";
        if (change === "amount") proofs[0]!.refunds[0]!.amountMinor = 1999;
        await expect(
          applyInvoiceProviderReconciliation(db, {
            ...ownerScope(),
            revision: plan.revision,
            proofs,
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(
          (await getInvoiceSettlement(db, scope())).reconciliationRequired,
        ).toBe(true);
      }
    });
    test("failed exact proof requires a returned balance transaction before one compensating entry", async () => {
      const { event, refund } = await confirmedStripeRefund();
      await expect(
        applyStripeInvoicePaymentEvent(db, {
          ...event,
          refunds: [{ ...refund, status: "failed" }],
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        applyStripeInvoicePaymentEvent(db, {
          ...event,
          refunds: [
            {
              ...refund,
              status: "failed",
              verifiedBy: "resource_get",
              failureBalanceTransactionId: "txn_returnedFixture",
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 409 });
      const plan = await providerPlan();
      const proofs = resourceProofs(plan);
      proofs[0]!.refunds[0]!.status = "failed";
      await expect(
        applyInvoiceProviderReconciliation(db, {
          ...ownerScope(),
          revision: plan.revision,
          proofs,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(2);
      proofs[0]!.refunds[0]!.failureBalanceTransactionId =
        "txn_returnedFixture";
      await applyInvoiceProviderReconciliation(db, {
        ...ownerScope(),
        revision: plan.revision,
        proofs,
      });
      const result = await getInvoiceSettlement(db, scope());
      expect(result.entries).toHaveLength(3);
      expect(
        result.entries.filter((row) => row.kind === "refund_reversal"),
      ).toHaveLength(1);
      expect(result.projection).toMatchObject({
        netSettledMinor: "10000",
        refundedMinor: "0",
        status: "paid",
      });
      expect(result.reconciliationRequired).toBe(false);
    });
    test("an unresolved create without a provider ID is manual_unknown, not proof by known resources", async () => {
      const { event, refund } = await confirmedStripeRefund();
      const unknown = await reserveInvoicePayment(db, scope());
      expect(unknown.paymentIntentId).toBeNull();
      await expect(
        applyStripeInvoicePaymentEvent(db, {
          ...event,
          refunds: [{ ...refund, status: "pending" }],
        }),
      ).rejects.toMatchObject({ status: 409 });
      const result = await getInvoiceSettlement(db, scope());
      expect(result.reconciliationRequired).toBe(true);
      expect(result.providerVerificationAvailable).toBe(false);
      await expect(
        getInvoiceProviderReconciliationPlan(db, ownerScope()),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await db.execute<{ reason: string }>(
            sql`select reason from invoice_settlement_state where invoice_id=${f.own.invoiceId}::uuid`,
          )
        ).rows[0]?.reason,
      ).toBe("manual_unknown");
    });
    test("a late succeeded refund after a proven reversal cannot silently change money or clear uncertainty", async () => {
      const { event, refund } = await confirmedStripeRefund();
      await applyStripeInvoicePaymentEvent(db, {
        ...event,
        refunds: [
          {
            ...refund,
            status: "failed",
            verifiedBy: "resource_get",
            failureBalanceTransactionId: "txn_returnedFixture",
          },
        ],
      });
      const before = await getInvoiceSettlement(db, scope());
      await expect(
        applyStripeInvoicePaymentEvent(db, event),
      ).rejects.toMatchObject({ status: 409 });
      const plan = await providerPlan();
      const proofs = resourceProofs(plan);
      proofs[0]!.refunds[0]!.status = "succeeded";
      await expect(
        applyInvoiceProviderReconciliation(db, {
          ...ownerScope(),
          revision: plan.revision,
          proofs,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const after = await getInvoiceSettlement(db, scope());
      expect(after.entries).toEqual(before.entries);
      expect(after.projection).toEqual(before.projection);
      expect(after.reconciliationRequired).toBe(true);
    });
    test("a new known-resource anomaly cannot downgrade an existing manual_unknown marker", async () => {
      await confirmedStripeRefund();
      await requireInvoiceSettlementProviderReconciliation(db, scope());
      const plan = await providerPlan();
      await db.execute(
        sql`update invoice_settlement_state set reason='manual_unknown' where invoice_id=${f.own.invoiceId}::uuid`,
      );
      await requireInvoiceSettlementProviderReconciliation(db, scope());
      await expect(
        applyInvoiceProviderReconciliation(db, {
          ...ownerScope(),
          revision: plan.revision,
          proofs: resourceProofs(plan),
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await getInvoiceSettlement(db, scope())).providerVerificationAvailable,
      ).toBe(false);
      expect(
        (await getInvoiceSettlement(db, scope())).reconciliationRequired,
      ).toBe(true);
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
