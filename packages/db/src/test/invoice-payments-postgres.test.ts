import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import { and, eq, sql } from "drizzle-orm";
import type { Database, TransactionClient } from "../client";
import { InvoicePaymentError } from "../errors";
import {
  applyStripeInvoicePaymentEvent,
  attachInvoicePayment,
  getInvoiceRefundContext,
  requireInvoicePaymentReconciliation,
  reserveInvoicePayment,
} from "../queries/invoice-payments";
import {
  deleteInvoice,
  draftInvoice,
  updateInvoice,
} from "../queries/invoices";
import { invoicePaymentReservations, invoices, teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const rolledBack = Symbol("payment fixture complete");
type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed(tx: TransactionClient) {
  const teamId = randomUUID();
  const invoiceId = randomUUID();
  await tx.insert(teams).values({
    id: teamId,
    inboxId: teamId,
    name: "Payment fixture",
    stripeAccountId: "acct_fixture",
    stripeConnectStatus: "connected",
  });
  await tx.insert(invoices).values({
    id: invoiceId,
    teamId,
    userId: null,
    invoiceNumber: "INV-001",
    amount: 120.05,
    subtotal: 120.05,
    currency: "USD",
    status: "unpaid",
    template: {
      currency: "USD",
      paymentEnabled: true,
      includeTax: false,
      includeVat: false,
    },
    lineItems: [{ name: "Service", price: 120.05, quantity: 1 }],
    token: "local-payment-fixture-token",
  });
  return { invoiceId, teamId };
}

function draftInput(fixture: Fixture) {
  return {
    id: fixture.invoiceId,
    teamId: fixture.teamId,
    userId: null,
    token: "local-payment-fixture-token",
    invoiceNumber: "INV-001",
    issueDate: "2026-11-01T00:00:00.000Z",
    dueDate: "2026-12-01T00:00:00.000Z",
    template: { currency: "USD" },
  };
}

describe.skipIf(!isTestDatabaseAvailable())(
  "invoice payment reservations (isolated PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);

    async function withInvoice(
      run: (tx: TransactionClient, fixture: Fixture) => Promise<void>,
    ) {
      try {
        await db.transaction(async (tx) => {
          await run(tx, await seed(tx));
          throw rolledBack;
        });
      } catch (error) {
        if (error !== rolledBack) throw error;
      }
    }

    test("reserves one immutable amount/account/payload before any provider attachment", async () => {
      await withInvoice(async (tx, f) => {
        const first = await reserveInvoicePayment(tx, f);
        const again = await reserveInvoicePayment(tx, f);
        expect(again.id).toBe(first.id);
        expect(first).toMatchObject({
          ...f,
          amountMinor: 12005,
          currency: "usd",
          stripeAccountId: "acct_fixture",
          invoiceNumber: "INV-001",
          state: "reserved",
          paymentIntentId: null,
        });
        expect(
          await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.invoiceId, f.invoiceId)),
        ).toHaveLength(1);
      });
    });

    test("reservation prevents financial and identity edits but allows metadata without changing its stored request", async () => {
      await withInvoice(async (tx, f) => {
        const reservation = await reserveInvoicePayment(tx, f);
        await expect(
          draftInvoice(tx, {
            ...draftInput(f),
            lineItems: [{ price: 200, quantity: 1 }],
          }),
        ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        await expect(
          draftInvoice(tx, {
            ...draftInput(f),
            invoiceNumber: "INV-002",
          }),
        ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        const saved = await draftInvoice(tx, {
          ...draftInput(f),
          dueDate: "2026-12-15T00:00:00.000Z",
          noteDetails: JSON.stringify({ type: "doc", content: [] }),
        });
        expect(saved.amount).toBe(120.05);
        expect(saved.invoiceNumber).toBe("INV-001");
        expect(new Date(saved.dueDate!).toISOString()).toBe(
          "2026-12-15T00:00:00.000Z",
        );
        const again = await reserveInvoicePayment(tx, f);
        expect(again.id).toBe(reservation.id);
        expect(again.invoiceNumber).toBe("INV-001");
      });
    });

    test("attaches only its current invoice/team/reservation and supports idempotent confirmation", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        expect(
          await attachInvoicePayment(tx, {
            ...r,
            teamId: randomUUID(),
            paymentIntentId: "pi_fixture",
          }),
        ).toBe(false);
        expect(
          await attachInvoicePayment(tx, {
            ...r,
            id: randomUUID(),
            paymentIntentId: "pi_fixture",
          }),
        ).toBe(false);
        expect(
          await attachInvoicePayment(tx, {
            ...r,
            paymentIntentId: "pi_fixture",
          }),
        ).toBe(true);
        expect(
          await attachInvoicePayment(tx, {
            ...r,
            paymentIntentId: "pi_fixture",
          }),
        ).toBe(true);
        const stored = await reserveInvoicePayment(tx, f);
        expect(stored).toMatchObject({
          paymentIntentId: "pi_fixture",
          state: "attached",
        });
      });
    });

    test("foreign-team reservation lookup does not reveal or reserve an invoice", async () => {
      await withInvoice(async (tx, f) => {
        await expect(
          reserveInvoicePayment(tx, { ...f, teamId: randomUUID() }),
        ).rejects.toMatchObject({ status: 404 });
        expect(
          await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.invoiceId, f.invoiceId)),
        ).toHaveLength(0);
      });
    });

    for (const status of [
      "draft",
      "scheduled",
      "paid",
      "refunded",
      "canceled",
    ] as const) {
      test(`does not reserve a ${status} invoice`, async () => {
        await withInvoice(async (tx, f) => {
          await tx
            .update(invoices)
            .set({ status })
            .where(eq(invoices.id, f.invoiceId));
          await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
            status: 400,
          });
        });
      });
    }

    test("overdue invoice remains payable", async () => {
      await withInvoice(async (tx, f) => {
        await tx
          .update(invoices)
          .set({ status: "overdue" })
          .where(eq(invoices.id, f.invoiceId));
        expect((await reserveInvoicePayment(tx, f)).amountMinor).toBe(12005);
      });
    });

    test("disabling payments or disconnecting the account blocks the handoff", async () => {
      await withInvoice(async (tx, f) => {
        await tx
          .update(invoices)
          .set({ template: { paymentEnabled: false } })
          .where(eq(invoices.id, f.invoiceId));
        await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
          status: 400,
        });
        await tx
          .update(invoices)
          .set({ template: { paymentEnabled: true } })
          .where(eq(invoices.id, f.invoiceId));
        await tx
          .update(teams)
          .set({ stripeConnectStatus: "restricted" })
          .where(eq(teams.id, f.teamId));
        await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
          status: 400,
        });
      });
    });

    for (const change of ["amount", "currency"] as const) {
      test(`issued ${change} cannot change during provider IO and the original reservation remains attachable`, async () => {
        await withInvoice(async (tx, f) => {
          const r = await reserveInvoicePayment(tx, f);
          const [before] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          expect(before).toBeDefined();
          expect(before?.documentSnapshot).not.toBeNull();
          // The full foundation protects issued financial identity at the DB
          // boundary. A savepoint contains the expected SQL error; no guard is
          // disabled and no impossible financial mutation is injected.
          await expect(
            tx.transaction(async (savepoint) => {
              await savepoint
                .update(invoices)
                .set(
                  change === "amount" ? { amount: 200 } : { currency: "EUR" },
                )
                .where(eq(invoices.id, f.invoiceId));
            }),
          ).rejects.toMatchObject({
            cause: {
              code: "23514",
              message: expect.stringContaining("Issued invoice is immutable"),
            },
          });
          const [after] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          expect(after).toEqual(before);
          const [reserved] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(reserved).toMatchObject({
            state: "reserved",
            amountMinor: 12005,
            currency: "usd",
            paymentIntentId: null,
          });
          expect(
            await attachInvoicePayment(tx, {
              ...r,
              paymentIntentId: "pi_fixture",
            }),
          ).toBe(true);
          const [attached] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(attached).toMatchObject({
            state: "attached",
            amountMinor: 12005,
            currency: "usd",
            paymentIntentId: "pi_fixture",
            failureCode: null,
          });
        });
      });
    }

    for (const change of [
      "cancel",
      "account",
      "restricted",
      "disabled",
    ] as const) {
      test(`current ${change} during HTTP prevents attachment and durably records the known intent`, async () => {
        await withInvoice(async (tx, f) => {
          const r = await reserveInvoicePayment(tx, f);
          if (change === "cancel")
            await updateInvoice(tx, {
              id: f.invoiceId,
              teamId: f.teamId,
              status: "canceled",
            });
          if (change === "account")
            await tx
              .update(teams)
              .set({ stripeAccountId: "acct_other" })
              .where(eq(teams.id, f.teamId));
          if (change === "restricted")
            await tx
              .update(teams)
              .set({ stripeConnectStatus: "restricted" })
              .where(eq(teams.id, f.teamId));
          if (change === "disabled")
            await tx
              .update(invoices)
              .set({ template: { paymentEnabled: false } })
              .where(eq(invoices.id, f.invoiceId));
          expect(
            await attachInvoicePayment(tx, {
              ...r,
              paymentIntentId: "pi_fixture",
            }),
          ).toBe(false);
          const [stored] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(stored).toMatchObject({
            state: "reconciliation_required",
            paymentIntentId: "pi_fixture",
          });
          const [invoice] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          expect(invoice?.paymentIntentId).toBeNull();
        });
      });
    }

    test("unknown attempts beyond the replay window remain blocked after rejection commits", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await tx
          .update(invoicePaymentReservations)
          .set({
            createdAt: sql`clock_timestamp() - interval '24 hours'`,
            lastAttemptAt: sql`clock_timestamp() - interval '24 hours'`,
          })
          .where(eq(invoicePaymentReservations.id, r.id));
        await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
          status: 409,
        });
        const [stored] = await tx
          .select()
          .from(invoicePaymentReservations)
          .where(eq(invoicePaymentReservations.id, r.id));
        expect(stored?.state).toBe("reconciliation_required");
        await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
          status: 409,
        });
      });
    });

    test("backwards clock relative to the last attempt prevents replay", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await tx
          .update(invoicePaymentReservations)
          .set({ lastAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
          .where(eq(invoicePaymentReservations.id, r.id));
        await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
          status: 409,
        });
      });
    });

    test("legacy attached intent is adopted without inventing a new provider request", async () => {
      await withInvoice(async (tx, f) => {
        await tx
          .update(invoices)
          .set({ paymentIntentId: "pi_legacy" })
          .where(eq(invoices.id, f.invoiceId));
        const r = await reserveInvoicePayment(tx, f);
        expect(r).toMatchObject({
          state: "attached",
          paymentIntentId: "pi_legacy",
        });
        await tx
          .update(invoicePaymentReservations)
          .set({ createdAt: sql`clock_timestamp() - interval '30 days'` })
          .where(eq(invoicePaymentReservations.id, r.id));
        expect((await reserveInvoicePayment(tx, f)).paymentIntentId).toBe(
          "pi_legacy",
        );
      });
    });

    test("mismatched invoice/team pair cannot be persisted even by a backend insert", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await expect(
          tx.transaction(async (savepoint) => {
            await savepoint
              .update(invoicePaymentReservations)
              .set({ teamId: randomUUID() })
              .where(eq(invoicePaymentReservations.id, r.id));
          }),
        ).rejects.toThrow();
        expect((await reserveInvoicePayment(tx, f)).teamId).toBe(f.teamId);
      });
    });

    test("reconciliation marker is tenant-scoped and cannot be cleared by attachment", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await requireInvoicePaymentReconciliation(
          tx,
          { ...r, teamId: randomUUID() },
          "foreign",
        );
        expect((await reserveInvoicePayment(tx, f)).state).toBe("reserved");
        await requireInvoicePaymentReconciliation(
          tx,
          r,
          "fixture",
          "pi_fixture",
        );
        expect(
          await attachInvoicePayment(tx, {
            ...r,
            paymentIntentId: "pi_fixture",
          }),
        ).toBe(false);
        await expect(reserveInvoicePayment(tx, f)).rejects.toMatchObject({
          status: 409,
        });
      });
    });

    for (const status of ["paid", "refunded", "canceled"] as const) {
      test(`${status} cannot be reopened to bypass financial immutability`, async () => {
        await withInvoice(async (tx, f) => {
          await tx
            .update(invoices)
            .set({ status })
            .where(eq(invoices.id, f.invoiceId));
          await expect(
            updateInvoice(tx, {
              id: f.invoiceId,
              teamId: f.teamId,
              status: "unpaid",
            }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
          await expect(
            updateInvoice(tx, {
              id: f.invoiceId,
              teamId: f.teamId,
              status: "draft",
            }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        });
      });
    }

    test("historical payment timestamps keep a legacy reopened invoice immutable and unpayable", async () => {
      await withInvoice(async (tx, f) => {
        await tx
          .update(invoices)
          .set({ paidAt: "2026-01-01T00:00:00.000Z" })
          .where(eq(invoices.id, f.invoiceId));
        await expect(
          draftInvoice(tx, {
            ...draftInput(f),
            lineItems: [{ price: 200, quantity: 1 }],
          }),
        ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        await expect(
          updateInvoice(tx, {
            id: f.invoiceId,
            teamId: f.teamId,
            paidAt: null,
          }),
        ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        await expect(reserveInvoicePayment(tx, f)).rejects.toBeInstanceOf(
          InvoicePaymentError,
        );
      });
    });

    test("existing provider ID cannot be cleared or replaced through generic invoice updates", async () => {
      await withInvoice(async (tx, f) => {
        await tx
          .update(invoices)
          .set({ paymentIntentId: "pi_fixture" })
          .where(eq(invoices.id, f.invoiceId));
        for (const paymentIntentId of [null, "pi_other"]) {
          await expect(
            updateInvoice(tx, {
              id: f.invoiceId,
              teamId: f.teamId,
              paymentIntentId,
            }),
          ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
        }
        expect(
          (
            await updateInvoice(tx, {
              id: f.invoiceId,
              teamId: f.teamId,
              internalNote: "Payment checked",
            })
          )?.internalNote,
        ).toBe("Payment checked");
      });
    });

    test("company deletion still cascades reservation rows", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await tx.delete(teams).where(eq(teams.id, f.teamId));
        expect(
          await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id)),
        ).toHaveLength(0);
      });
    });

    test("refund context retains the original account after disconnecting or reconnecting", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await attachInvoicePayment(tx, { ...r, paymentIntentId: "pi_fixture" });
        await updateInvoice(tx, {
          id: f.invoiceId,
          teamId: f.teamId,
          status: "paid",
        });
        await tx
          .update(teams)
          .set({
            stripeAccountId: "acct_replacement",
            stripeConnectStatus: "connected",
          })
          .where(eq(teams.id, f.teamId));
        expect(await getInvoiceRefundContext(tx, f)).toEqual({
          ...f,
          paymentIntentId: "pi_fixture",
          stripeAccountId: "acct_fixture",
          amountMinor: 12005,
          currency: "usd",
        });
        await tx
          .update(teams)
          .set({ stripeAccountId: null, stripeConnectStatus: null })
          .where(eq(teams.id, f.teamId));
        expect((await getInvoiceRefundContext(tx, f)).stripeAccountId).toBe(
          "acct_fixture",
        );
      });
    });

    test("refund context is tenant-scoped and does not accept an unpaid invoice", async () => {
      await withInvoice(async (tx, f) => {
        await expect(
          getInvoiceRefundContext(tx, { ...f, teamId: randomUUID() }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(getInvoiceRefundContext(tx, f)).rejects.toMatchObject({
          status: 400,
        });
      });
    });

    test("a legacy refund context uses current account only as a provider-verification candidate", async () => {
      await withInvoice(async (tx, f) => {
        await tx
          .update(invoices)
          .set({ status: "paid", paymentIntentId: "pi_legacy" })
          .where(eq(invoices.id, f.invoiceId));
        expect(await getInvoiceRefundContext(tx, f)).toMatchObject({
          paymentIntentId: "pi_legacy",
          stripeAccountId: "acct_fixture",
        });
        expect(
          await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.invoiceId, f.invoiceId)),
        ).toHaveLength(0);
      });
    });

    test("blocked or financially mismatched reservations cannot authorize refunds", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await attachInvoicePayment(tx, { ...r, paymentIntentId: "pi_fixture" });
        await updateInvoice(tx, {
          id: f.invoiceId,
          teamId: f.teamId,
          status: "paid",
        });
        await requireInvoicePaymentReconciliation(tx, r, "fixture_block");
        await expect(getInvoiceRefundContext(tx, f)).rejects.toMatchObject({
          status: 409,
        });
        await tx
          .update(invoicePaymentReservations)
          .set({ state: "attached", amountMinor: 12004 })
          .where(eq(invoicePaymentReservations.id, r.id));
        await expect(getInvoiceRefundContext(tx, f)).rejects.toMatchObject({
          status: 409,
        });
      });
    });

    for (const kind of ["paid", "refunded"] as const) {
      test(`a ${kind} webhook winning attachment does not corrupt the established reservation`, async () => {
        await withInvoice(async (tx, f) => {
          const r = await reserveInvoicePayment(tx, f);
          await applyStripeInvoicePaymentEvent(tx, {
            ...f,
            reservationId: r.id,
            paymentIntentId: "pi_fixture",
            stripeAccountId: "acct_fixture",
            amountMinor: 12005,
            currency: "usd",
            occurredAt: "2026-11-01T00:00:00.000Z",
            kind,
            ...(kind === "refunded"
              ? {
                  refunds: [
                    {
                      id: "re_fixture",
                      amountMinor: 12005,
                      status: "succeeded",
                    },
                  ],
                }
              : {}),
          });
          const [before] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(
            await attachInvoicePayment(tx, {
              ...r,
              paymentIntentId: "pi_fixture",
            }),
          ).toBe(false);
          const [after] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(after).toEqual(before);
          expect(after?.state).toBe("settled");
        });
      });
    }

    test("known Stripe event binds exact intent/account/money, is idempotent and a refund wins out-of-order", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await attachInvoicePayment(tx, { ...r, paymentIntentId: "pi_fixture" });
        const event = {
          ...f,
          reservationId: r.id,
          paymentIntentId: "pi_fixture",
          stripeAccountId: "acct_fixture",
          amountMinor: 12005,
          currency: "usd",
          occurredAt: "2026-11-01T00:00:00.000Z",
          kind: "paid" as const,
        };
        const paid = await applyStripeInvoicePaymentEvent(tx, event);
        expect(paid.invoice.status).toBe("paid");
        const duplicate = await applyStripeInvoicePaymentEvent(tx, {
          ...event,
          occurredAt: "2026-11-02T00:00:00.000Z",
        });
        expect(duplicate.invoice.paidAt).toBe(paid.invoice.paidAt);
        const refund = await applyStripeInvoicePaymentEvent(tx, {
          ...event,
          kind: "refunded",
          refunds: [
            { id: "re_fixture", amountMinor: 12005, status: "succeeded" },
          ],
        });
        expect(refund.invoice.status).toBe("refunded");
        const late = await applyStripeInvoicePaymentEvent(tx, event);
        expect(late.invoice.status).toBe("refunded");
        expect(late.notify).toBe(false);
      });
    });

    for (const mismatch of [
      "amount",
      "currency",
      "account",
      "intent",
    ] as const) {
      test(`webhook ${mismatch} mismatch cannot mark an invoice paid`, async () => {
        await withInvoice(async (tx, f) => {
          const r = await reserveInvoicePayment(tx, f);
          await attachInvoicePayment(tx, {
            ...r,
            paymentIntentId: "pi_fixture",
          });
          const event = {
            ...f,
            paymentIntentId: "pi_fixture",
            stripeAccountId: "acct_fixture",
            amountMinor: 12005,
            currency: "usd",
            occurredAt: "2026-11-01T00:00:00.000Z",
            kind: "paid" as const,
          };
          if (mismatch === "amount") event.amountMinor++;
          if (mismatch === "currency") event.currency = "eur";
          if (mismatch === "account") event.stripeAccountId = "acct_other";
          if (mismatch === "intent") event.paymentIntentId = "pi_other";
          await expect(
            applyStripeInvoicePaymentEvent(tx, event),
          ).rejects.toMatchObject({ status: 409 });
          const [invoice] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          expect(invoice?.status).toBe("unpaid");
        });
      });
    }

    test("metadata alone cannot claim an unbound invoice payment", async () => {
      await withInvoice(async (tx, f) => {
        await expect(
          applyStripeInvoicePaymentEvent(tx, {
            ...f,
            paymentIntentId: "pi_attacker",
            stripeAccountId: "acct_fixture",
            amountMinor: 12005,
            currency: "usd",
            occurredAt: "2026-11-01T00:00:00.000Z",
            kind: "paid",
          }),
        ).rejects.toMatchObject({ status: 409 });
      });
    });

    test("a foreign account with forged invoice metadata cannot change or block the victim's reservation", async () => {
      await withInvoice(async (tx, f) => {
        const r = await reserveInvoicePayment(tx, f);
        await attachInvoicePayment(tx, { ...r, paymentIntentId: "pi_fixture" });
        const [before] = await tx
          .select()
          .from(invoicePaymentReservations)
          .where(eq(invoicePaymentReservations.id, r.id));
        await expect(
          applyStripeInvoicePaymentEvent(tx, {
            ...f,
            reservationId: r.id,
            paymentIntentId: "pi_fixture",
            stripeAccountId: "acct_attacker",
            amountMinor: 12005,
            currency: "usd",
            occurredAt: "2026-11-01T00:00:00.000Z",
            kind: "paid",
          }),
        ).rejects.toMatchObject({ status: 409 });
        const [after] = await tx
          .select()
          .from(invoicePaymentReservations)
          .where(eq(invoicePaymentReservations.id, r.id));
        expect(after).toEqual(before);
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, f.invoiceId));
        expect(invoice?.status).toBe("unpaid");
      });
    });

    for (const mismatch of [
      "account",
      "reservation",
      "missing_identity",
    ] as const) {
      test(`a forged pre-attachment refund ${mismatch} cannot mutate the victim's invoice or reservation`, async () => {
        await withInvoice(async (tx, f) => {
          const r = await reserveInvoicePayment(tx, f);
          const [beforeInvoice] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          const [beforeReservation] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(beforeInvoice?.paymentIntentId).toBeNull();
          expect(beforeReservation?.paymentIntentId).toBeNull();
          await expect(
            applyStripeInvoicePaymentEvent(tx, {
              ...(mismatch === "missing_identity"
                ? {}
                : {
                    ...f,
                    reservationId:
                      mismatch === "reservation" ? randomUUID() : r.id,
                  }),
              paymentIntentId: "pi_attacker",
              stripeAccountId:
                mismatch === "account" ? "acct_attacker" : "acct_fixture",
              amountMinor: 12005,
              currency: "usd",
              occurredAt: "2026-11-01T00:00:00.000Z",
              kind: "refunded",
              refunds: [
                { id: "re_fixture", amountMinor: 12005, status: "succeeded" },
              ],
            }),
          ).rejects.toMatchObject({ status: 409 });
          const [afterInvoice] = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, f.invoiceId));
          const [afterReservation] = await tx
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.id, r.id));
          expect(afterInvoice).toEqual(beforeInvoice);
          expect(afterReservation).toEqual(beforeReservation);
        });
      });
    }

    test("concurrent requests serialize on the invoice and return one reservation", async () => {
      const f = await db.transaction(seed);
      try {
        const [a, b] = await Promise.all([
          reserveInvoicePayment(db, f),
          reserveInvoicePayment(db, f),
        ]);
        expect(a.id).toBe(b.id);
        expect(
          await db
            .select()
            .from(invoicePaymentReservations)
            .where(eq(invoicePaymentReservations.invoiceId, f.invoiceId)),
        ).toHaveLength(1);
      } finally {
        await db.delete(teams).where(eq(teams.id, f.teamId));
      }
    });

    test("a concurrent financial save waits for the reservation commit, then fails without repricing", async () => {
      const f = await db.transaction(seed);
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reserving = db.transaction(async (tx) => {
        const reservation = await reserveInvoicePayment(tx, f);
        ready.resolve();
        await release.promise;
        return reservation;
      });
      try {
        await Promise.race([ready.promise, reserving.then(() => undefined)]);
        const saving = draftInvoice(db, {
          ...draftInput(f),
          lineItems: [{ price: 200, quantity: 1 }],
        });
        const result = saving.then(
          () => "saved",
          (error) => error,
        );
        expect(
          await Promise.race([
            result,
            new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
          ]),
        ).toBe("waiting");
        release.resolve();
        await reserving;
        expect(await result).toBeInstanceOf(InvoiceFinancialStateError);
        const [invoice] = await db
          .select()
          .from(invoices)
          .where(
            and(eq(invoices.id, f.invoiceId), eq(invoices.teamId, f.teamId)),
          );
        expect(invoice?.amount).toBe(120.05);
      } finally {
        release.resolve();
        await reserving.catch(() => undefined);
        await db.delete(teams).where(eq(teams.id, f.teamId));
      }
    });

    test("canceling a reserved payment does not make its history deletable", async () => {
      const f = await db.transaction(seed);
      try {
        await reserveInvoicePayment(db, f);
        await updateInvoice(db, {
          id: f.invoiceId,
          teamId: f.teamId,
          status: "canceled",
        });
        await expect(
          deleteInvoice(db, { id: f.invoiceId, teamId: f.teamId }),
        ).rejects.toBeInstanceOf(InvoiceFinancialStateError);
      } finally {
        await db.delete(teams).where(eq(teams.id, f.teamId));
      }
    });
  },
);
