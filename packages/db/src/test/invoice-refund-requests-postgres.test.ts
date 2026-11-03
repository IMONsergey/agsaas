import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { DurableRefundProvider } from "../../../../apps/api/src/services/invoice-refund-engine";
import { resumeDurableInvoiceRefund } from "../../../../apps/api/src/services/invoice-refund-intents";
import type { Database } from "../client";
import { financialRequestHash } from "../financial-job";
import {
  type InvoiceRefundRequest,
  type InvoiceRefundResource,
  refundReplayRemaining,
  refundRequestPayload,
} from "../invoice-refund-request";
import { updateInvoiceWithIntent } from "../queries/invoice-commands";
import {
  applyStripeInvoicePaymentEvent,
  attachInvoicePayment,
  getInvoiceProviderReconciliationPlan,
  getInvoiceRefundContext,
  reserveInvoicePayment,
} from "../queries/invoice-payments";
import {
  applyInvoiceRefundResource,
  claimInvoiceRefundDispatch,
  getInvoiceRefundRequestPlan,
  markInvoiceRefundDispatchUnknown,
  prepareInvoiceRefundRequest,
  retainInvoiceRefundResource,
} from "../queries/invoice-refund-requests";
import {
  getInvoiceSettlement,
  reconcileInvoiceSettlement,
  recordInvoiceSettlement,
  requireInvoiceSettlementProviderReconciliation,
} from "../queries/invoice-settlements";
import { invoices, teams, usersOnTeam } from "../schema";
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

type ProviderRefund = Awaited<
  ReturnType<DurableRefundProvider["refunds"]["retrieve"]>
>;

describe.skipIf(!isTestDatabaseAvailable())(
  "durable refund requests, actual guards and fake provider (isolated PostgreSQL)",
  () => {
    let db: Database, f: TenantIsolationFixture;
    let paymentIntentId: string, stripeAccountId: string;
    beforeAll(() => {
      db = getTestDatabase();
    });
    const scope = () => ({ invoiceId: f.own.invoiceId, teamId: f.own.teamId });
    const ownerScope = () => ({ ...scope(), actorId: f.own.userId });
    beforeEach(async () => {
      f = await createTenantIsolationFixture(db);
      paymentIntentId = `pi_${randomUUID().replaceAll("-", "")}`;
      stripeAccountId = `acct_${f.own.teamId.replaceAll("-", "")}`;
      await db
        .update(teams)
        .set({ stripeAccountId, stripeConnectStatus: "connected" })
        .where(eq(teams.id, f.own.teamId));
      await db
        .update(invoices)
        .set({
          status: "unpaid",
          template: { paymentEnabled: true, currency: "USD" },
        })
        .where(eq(invoices.id, f.own.invoiceId));
      const reserved = await reserveInvoicePayment(db, scope());
      expect(
        await attachInvoicePayment(db, { ...reserved, paymentIntentId }),
      ).toBe(true);
      await applyStripeInvoicePaymentEvent(db, {
        ...scope(),
        reservationId: reserved.id,
        paymentIntentId,
        stripeAccountId,
        amountMinor: 10000,
        currency: "usd",
        kind: "paid",
        occurredAt: "2026-11-03T09:00:00Z",
      });
    });
    afterEach(async () => {
      if (!f) return;
      // Restore only this test actor, then reconcile only this fixture's fake resources.
      // No trigger/constraint is disabled, and unresolved requests are never directly deleted.
      await db
        .update(usersOnTeam)
        .set({ role: "owner" })
        .where(
          and(
            eq(usersOnTeam.teamId, f.own.teamId),
            eq(usersOnTeam.userId, f.own.userId),
          ),
        );
      const active = await db.execute<{ id: string }>(
        sql`SELECT id FROM public.invoice_refund_requests WHERE team_id=${f.own.teamId}::uuid AND state NOT IN ('settled','failed')`,
      );
      for (const row of active.rows) {
        const current = await getInvoiceRefundRequestPlan(db, {
          ...ownerScope(),
          requestId: row.id,
        });
        const proof = resource(current.request, { status: "failed" });
        const retained = await retainInvoiceRefundResource(db, {
          ...scope(),
          requestId: row.id,
          revision: current.revision,
          resource: proof,
        });
        if (!retained.applicableRevision)
          throw new Error("Fixture cleanup proof changed concurrently");
        await applyInvoiceRefundResource(db, {
          ...ownerScope(),
          requestId: row.id,
          revision: retained.applicableRevision,
          resource: proof,
        });
      }
      await db.execute(
        sql`DELETE FROM public.security_audit_events WHERE team_id IN (${f.own.teamId}::uuid,${f.other.teamId}::uuid)`,
      );
      await removeTenantIsolationFixture(db, f);
    });
    afterAll(closeDatabase);
    const prepare = (operationId: string = randomUUID()) =>
      prepareInvoiceRefundRequest(db, { ...ownerScope(), operationId });
    const plan = (requestId: string) =>
      getInvoiceRefundRequestPlan(db, { ...ownerScope(), requestId });
    function resource(
      request: InvoiceRefundRequest,
      changes: Partial<InvoiceRefundResource> = {},
    ): InvoiceRefundResource {
      return {
        id: request.providerRefundId ?? `re_${request.id.replaceAll("-", "")}`,
        paymentIntentId: request.paymentIntentId,
        amountMinor: request.refundAmountMinor,
        currency: request.currency,
        invoiceId: request.invoiceId,
        teamId: request.teamId,
        requestId: request.id,
        status: "succeeded",
        source: "resource_get",
        ...changes,
      };
    }
    function provider(request: InvoiceRefundRequest) {
      const records = new Map<string, ProviderRefund>();
      const from = (proof: InvoiceRefundResource): ProviderRefund => ({
        id: proof.id,
        payment_intent: proof.paymentIntentId,
        amount: proof.amountMinor,
        currency: proof.currency,
        status: proof.status,
        metadata: {
          invoice_id: proof.invoiceId!,
          team_id: proof.teamId!,
          invoice_refund_request_id: proof.requestId!,
        },
      });
      const payment = {
        id: request.paymentIntentId,
        amount: request.paymentAmountMinor,
        amount_received: request.paymentAmountMinor,
        currency: request.currency,
        status: "succeeded" as const,
        metadata: { invoice_id: request.invoiceId, team_id: request.teamId },
      };
      const api = {
        paymentIntents: {
          retrieve: mock(
            async (_id: string, _options: Stripe.RequestOptions) => payment,
          ),
        },
        refunds: {
          list: mock(
            async (
              _params: Stripe.RefundListParams,
              _options: Stripe.RequestOptions,
            ) => ({ data: [...records.values()], has_more: false }),
          ),
          retrieve: mock(
            async (id: string, _options: Stripe.RequestOptions) => {
              const value = records.get(id);
              if (!value) throw new Error("resource_missing");
              return value;
            },
          ),
          create: mock(
            async (
              _params: Stripe.RefundCreateParams,
              _options: Stripe.RequestOptions,
            ) => {
              const value = from(resource(request, { status: "pending" }));
              records.set(value.id, value);
              return value;
            },
          ),
        },
      } satisfies DurableRefundProvider;
      return { api, records, from };
    }
    async function assertGuard(statement: SQL, text: string) {
      let failure: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(statement);
        });
      } catch (error) {
        failure = error;
      }
      const codes: string[] = [],
        messages: string[] = [];
      for (
        let error = failure;
        error && typeof error === "object";
        error = "cause" in error ? error.cause : undefined
      ) {
        if ("code" in error) codes.push(String(error.code));
        if ("message" in error) messages.push(String(error.message));
      }
      expect(codes).toContain("P0001");
      expect(messages.join(" ")).toContain(text);
    }
    async function demote() {
      await db.insert(usersOnTeam).values({
        teamId: f.own.teamId,
        userId: f.other.userId,
        role: "owner",
      });
      await db
        .update(usersOnTeam)
        .set({ role: "member" })
        .where(
          and(
            eq(usersOnTeam.teamId, f.own.teamId),
            eq(usersOnTeam.userId, f.own.userId),
          ),
        );
    }
    async function historicalReserved(remainingSeconds: number) {
      const payment = (await getInvoiceSettlement(db, scope())).entries.find(
        (entry) =>
          entry.kind === "payment" &&
          entry.providerResourceId === paymentIntentId,
      )!;
      const id = randomUUID(),
        operationId = randomUUID();
      const payload = {
        payment_intent: paymentIntentId,
        amount: 10000,
        metadata: {
          invoice_id: f.own.invoiceId,
          team_id: f.own.teamId,
          invoice_refund_request_id: id,
        },
      };
      await db.execute(sql`INSERT INTO public.invoice_refund_requests
      (id,team_id,invoice_id,payment_entry_id,operation_id,stripe_account_id,payment_intent_id,payment_amount_minor,refund_amount_minor,currency,request_hash,idempotency_key,actor_id,created_at)
      VALUES (${id}::uuid,${f.own.teamId}::uuid,${f.own.invoiceId}::uuid,${payment.id}::uuid,${operationId}::uuid,
      ${stripeAccountId},${paymentIntentId},10000,10000,'usd',${financialRequestHash(payload)},${`invoice-refund/${id}/v2`},${f.own.userId}::uuid,
      clock_timestamp()-interval '23 hours'+${remainingSeconds}*interval '1 second')`);
      return plan(id);
    }

    test("one unresolved intent is retained before external work; duplicate never changes its age or amount", async () => {
      const operationId = randomUUID();
      const [a, b] = await Promise.all([
        prepare(operationId),
        prepare(operationId),
      ]);
      expect(a.request.id).toBe(b.request.id);
      expect(a.request.createdAt).toBe(b.request.createdAt);
      expect(a.request.refundAmountMinor).toBe(10000);
      expect(a.request.requestHash).toBe(
        financialRequestHash(refundRequestPayload(a.request)),
      );
      expect(a.request.state).toBe("reserved");
      await expect(prepare()).rejects.toMatchObject({ status: 409 });
      const audits = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM public.security_audit_events WHERE team_id=${f.own.teamId}::uuid AND operation='invoice.refund.prepare'`,
      );
      expect(audits.rows[0]?.count).toBe("1");
      const result = await getInvoiceSettlement(db, scope());
      expect(result.refundRequest?.requestId).toBe(a.request.id);
      expect(result.reconciliationRequired).toBe(true);
    });

    test("concurrent different operations cannot reserve the same refundable balance", async () => {
      const results = await Promise.allSettled([prepare(), prepare()]);
      expect(
        results.filter((value) => value.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((value) => value.status === "rejected"),
      ).toHaveLength(1);
      const rows = await db.execute(
        sql`SELECT 1 FROM public.invoice_refund_requests WHERE invoice_id=${f.own.invoiceId}::uuid`,
      );
      expect(rows.rows).toHaveLength(1);
    });

    test("intent and its audit roll back together before any network work", async () => {
      await expect(
        db.transaction(async (tx) => {
          await prepareInvoiceRefundRequest(tx, {
            ...ownerScope(),
            operationId: randomUUID(),
          });
          throw new Error("fixture rollback");
        }),
      ).rejects.toThrow("fixture rollback");
      expect(
        (await getInvoiceSettlement(db, scope())).refundRequest,
      ).toBeNull();
      const audits = await db.execute(
        sql`SELECT 1 FROM public.security_audit_events WHERE team_id=${f.own.teamId}::uuid AND operation='invoice.refund.prepare'`,
      );
      expect(audits.rows).toHaveLength(0);
    });

    test("an unknown request fences new manual money, refunds, checkout, Mark paid and journal-only reconciliation", async () => {
      const initial = await prepare();
      const claim = await claimInvoiceRefundDispatch(db, {
        ...ownerScope(),
        requestId: initial.request.id,
        revision: initial.revision,
      });
      expect(claim.kind).toBe("dispatch");
      if (claim.kind !== "dispatch") throw new Error("Expected dispatch");
      await markInvoiceRefundDispatchUnknown(db, {
        ...scope(),
        requestId: initial.request.id,
        claimToken: claim.claimToken,
      });
      const id = randomUUID();
      await expect(
        recordInvoiceSettlement(db, {
          ...ownerScope(),
          operationKey: financialRequestHash(id),
          kind: "payment",
          amountMinor: "1",
          currency: "usd",
          provider: "manual",
          providerAccountId: f.own.teamId,
          providerResourceId: id,
          occurredAt: "2026-11-03T09:00:00Z",
          reason: "Fixture transfer",
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(getInvoiceRefundContext(db, scope())).rejects.toMatchObject({
        status: 409,
      });
      await expect(reserveInvoicePayment(db, scope())).rejects.toMatchObject({
        status: 400,
      });
      // The command exposes a domain error. REST/tRPC map it to 409/CONFLICT.
      const markPaid = updateInvoiceWithIntent(db, {
        id: f.own.invoiceId,
        teamId: f.own.teamId,
        userId: f.own.userId,
        status: "paid",
      });
      await expect(markPaid).rejects.toBeInstanceOf(InvoiceFinancialStateError);
      await expect(markPaid).rejects.toMatchObject({
        message: "Existing settlement history requires reconciliation",
      });
      expect(
        await reconcileInvoiceSettlement(db, { ...ownerScope(), apply: true }),
      ).toMatchObject({ state: "requires_evidence", changed: false });
      await expect(
        getInvoiceProviderReconciliationPlan(db, ownerScope()),
      ).rejects.toMatchObject({ status: 409 });
      const replay = await prepare(initial.request.operationId);
      expect(replay.request).toMatchObject({
        state: "unknown",
        attemptCount: 1,
        createdAt: initial.request.createdAt,
      });
    });

    test("actual fake-provider timeout retains the claim; immediate retry cannot extend age or resend POST", async () => {
      const initial = await prepare();
      const fake = provider(initial.request);
      fake.api.refunds.create.mockImplementation(async () => {
        throw new Error("ETIMEDOUT");
      });
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 503 });
      const unknown = await plan(initial.request.id);
      expect(unknown.request).toMatchObject({
        state: "unknown",
        providerRefundId: null,
        attemptCount: 1,
      });
      expect(unknown.request.claimToken).not.toBeNull();
      expect(Date.parse(unknown.request.claimExpiresAt!)).toBeGreaterThan(
        Date.parse(unknown.databaseNow),
      );
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const duplicate = await prepare(initial.request.operationId);
      expect(duplicate.request.attemptCount).toBe(1);
      expect(duplicate.request.createdAt).toBe(initial.request.createdAt);
      expect(duplicate.request.firstAttemptAt).toBe(
        unknown.request.firstAttemptAt,
      );
      expect(duplicate.request.claimToken).toBe(unknown.request.claimToken);
      expect(fake.api.refunds.create).toHaveBeenCalledTimes(1);
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=${initial.request.id}::uuid`,
        "live unknown refund claim",
      );
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET attempt_count=attempt_count+1,last_attempt_at=clock_timestamp(),
      claim_expires_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() WHERE id=${initial.request.id}::uuid`,
        "fresh claim token",
      );
    });

    test("an expired claim needs a new fencing token, and the old worker cannot change the new attempt", async () => {
      const initial = await prepare();
      const firstToken = randomUUID();
      await db.execute(sql`UPDATE public.invoice_refund_requests SET state='unknown',attempt_count=1,
      first_attempt_at=clock_timestamp(),last_attempt_at=clock_timestamp(),claim_token=${firstToken}::uuid,
      claim_expires_at=clock_timestamp()+interval '100 milliseconds',updated_at=clock_timestamp() WHERE id=${initial.request.id}::uuid`);
      await Bun.sleep(150);
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET attempt_count=attempt_count+1,last_attempt_at=clock_timestamp(),
      claim_expires_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() WHERE id=${initial.request.id}::uuid`,
        "fresh claim token",
      );
      const current = await plan(initial.request.id);
      const next = await claimInvoiceRefundDispatch(db, {
        ...ownerScope(),
        requestId: initial.request.id,
        revision: current.revision,
      });
      if (next.kind !== "dispatch")
        throw new Error("Expected dispatch after the real first lease expires");
      expect(next.claimToken).not.toBe(firstToken);
      expect(next.request.firstAttemptAt).toBe(current.request.firstAttemptAt);
      await markInvoiceRefundDispatchUnknown(db, {
        ...scope(),
        requestId: initial.request.id,
        claimToken: firstToken,
      });
      const afterOldWorker = await plan(initial.request.id);
      expect(afterOldWorker.revision).toBe(next.revision);
      expect(afterOldWorker.request.claimToken).toBe(next.claimToken);
    });

    test("lost response after successful provider POST recovers through metadata plus exact GET, without second POST", async () => {
      const initial = await prepare();
      const fake = provider(initial.request);
      fake.api.refunds.create.mockImplementation(async () => {
        const succeeded = fake.from(resource(initial.request));
        fake.records.set(succeeded.id, succeeded);
        throw new Error("connection closed after provider committed");
      });
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        (await plan(initial.request.id)).request.providerRefundId,
      ).toBeNull();
      expect(
        await resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).toMatchObject({ status: "confirmed" });
      expect(fake.api.refunds.create).toHaveBeenCalledTimes(1);
      expect(fake.api.refunds.retrieve).toHaveBeenCalledTimes(1);
      const settlement = await getInvoiceSettlement(db, scope());
      expect(
        settlement.entries.filter((entry) => entry.kind === "refund"),
      ).toHaveLength(1);
      expect(settlement.projection?.netSettledMinor).toBe("0");
      expect(settlement.refundRequest).toBeNull();
      await resumeDurableInvoiceRefund(db, fake.api, {
        ...ownerScope(),
        requestId: initial.request.id,
      });
      expect(
        (await getInvoiceSettlement(db, scope())).entries.filter(
          (entry) => entry.kind === "refund",
        ),
      ).toHaveLength(1);
      expect(fake.api.refunds.create).toHaveBeenCalledTimes(1);
    });

    test("POST acknowledgment remains bound until exact GET; pending/unknown status cannot clear the fence", async () => {
      const initial = await prepare();
      const fake = provider(initial.request);
      await resumeDurableInvoiceRefund(db, fake.api, {
        ...ownerScope(),
        requestId: initial.request.id,
      });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
      for (const status of [
        "pending",
        "requires_action",
        null,
        "future_status",
      ] as const) {
        const value = fake.from(resource(initial.request, { status }));
        fake.records.set(value.id, value);
        await resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        });
        expect(
          (await getInvoiceSettlement(db, scope())).reconciliationRequired,
        ).toBe(true);
        expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(
          1,
        );
      }
      expect(fake.api.refunds.create).toHaveBeenCalledTimes(1);
      const failed = fake.from(resource(initial.request, { status: "failed" }));
      fake.records.set(failed.id, failed);
      expect(
        await resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).toMatchObject({ status: "failed" });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
      expect(
        (await getInvoiceSettlement(db, scope())).refundRequest,
      ).toBeNull();
    });

    test("a terminal failed request that later appears pending cannot leave money operations open", async () => {
      const initial = await prepare();
      const failed = resource(initial.request, { status: "failed" });
      const retained = await retainInvoiceRefundResource(db, {
        ...scope(),
        requestId: initial.request.id,
        revision: initial.revision,
        resource: failed,
      });
      await applyInvoiceRefundResource(db, {
        ...ownerScope(),
        requestId: initial.request.id,
        revision: retained.applicableRevision!,
        resource: failed,
      });
      expect(
        (await getInvoiceSettlement(db, scope())).reconciliationRequired,
      ).toBe(false);
      await applyStripeInvoicePaymentEvent(db, {
        ...scope(),
        paymentIntentId,
        stripeAccountId,
        amountMinor: 10000,
        currency: "usd",
        kind: "refunded",
        occurredAt: "2026-11-03T10:00:00Z",
        refunds: [{ id: failed.id, amountMinor: 10000, status: "pending" }],
      });
      const settlement = await getInvoiceSettlement(db, scope());
      expect(settlement.reconciliationRequired).toBe(true);
      expect(settlement.providerReconciliationRequired).toBe(true);
      expect(settlement.entries).toHaveLength(1);
      await expect(prepare()).rejects.toMatchObject({ status: 409 });
    });

    test("demotion before dispatch prevents POST; late receipt persists after dispatch and finalize still requires owner", async () => {
      const initial = await prepare();
      const fake = provider(initial.request);
      fake.api.refunds.list.mockImplementation(async () => {
        await demote();
        return { data: [], has_more: false };
      });
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(fake.api.refunds.create).not.toHaveBeenCalled();
      await db
        .update(usersOnTeam)
        .set({ role: "owner" })
        .where(
          and(
            eq(usersOnTeam.teamId, f.own.teamId),
            eq(usersOnTeam.userId, f.own.userId),
          ),
        );
      fake.api.refunds.list.mockImplementation(async () => ({
        data: [],
        has_more: false,
      }));
      fake.api.refunds.create.mockImplementation(async () => {
        await db
          .update(usersOnTeam)
          .set({ role: "member" })
          .where(
            and(
              eq(usersOnTeam.teamId, f.own.teamId),
              eq(usersOnTeam.userId, f.own.userId),
            ),
          );
        return fake.from(resource(initial.request, { status: "succeeded" }));
      });
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const raw = await db.execute<{ state: string; id: string }>(
        sql`SELECT state,provider_refund_id AS id FROM public.invoice_refund_requests WHERE id=${initial.request.id}::uuid`,
      );
      expect(raw.rows[0]).toEqual({
        state: "bound",
        id: resource(initial.request).id,
      });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
    });

    test("a revision changed during exact GET retains identity but cannot apply stale proof or erase another marker", async () => {
      const initial = await prepare();
      const proof = resource(initial.request);
      await requireInvoiceSettlementProviderReconciliation(db, {
        ...scope(),
        manualUnknown: true,
      });
      const retained = await retainInvoiceRefundResource(db, {
        ...scope(),
        requestId: initial.request.id,
        revision: initial.revision,
        resource: proof,
      });
      expect(retained.applicableRevision).toBeNull();
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
      const fresh = await plan(initial.request.id);
      const retainedFresh = await retainInvoiceRefundResource(db, {
        ...scope(),
        requestId: initial.request.id,
        revision: fresh.revision,
        resource: proof,
      });
      expect(retainedFresh.applicableRevision).not.toBeNull();
      await applyInvoiceRefundResource(db, {
        ...ownerScope(),
        requestId: initial.request.id,
        revision: retainedFresh.applicableRevision!,
        resource: proof,
      });
      const settlement = await getInvoiceSettlement(db, scope());
      expect(settlement.refundRequest).toBeNull();
      expect(settlement.providerReconciliationRequired).toBe(true);
      expect(settlement.reconciliationRequired).toBe(true);
      await expect(prepare()).rejects.toMatchObject({ status: 409 });
    });

    test("guard refuses identity/provider ID/creation/attempt and terminal rewrites; unresolved parent deletion rolls back", async () => {
      const initial = await prepare();
      const id = initial.request.id;
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET state='settled',provider_refund_id='re_shortcut',provider_status='succeeded',
      binding_verified=true,updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        "previously retained verified provider binding",
      );
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET refund_amount_minor=1,updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        "identity is immutable",
      );
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET created_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        "identity is immutable",
      );
      await assertGuard(
        sql`DELETE FROM public.invoice_refund_requests WHERE id=${id}::uuid`,
        "cannot be erased",
      );
      await assertGuard(
        sql`DELETE FROM public.teams WHERE id=${f.own.teamId}::uuid`,
        "cannot be erased",
      );
      const proof = resource(initial.request);
      const retained = await retainInvoiceRefundResource(db, {
        ...scope(),
        requestId: id,
        revision: initial.revision,
        resource: proof,
      });
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET provider_refund_id='re_other',updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        "write once",
      );
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET state='settled',updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        "exact confirmed journal entry",
      );

      await applyInvoiceRefundResource(db, {
        ...ownerScope(),
        requestId: id,
        revision: retained.applicableRevision!,
        resource: proof,
      });
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET state='bound',updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        "cannot be rewritten",
      );
      await expect(
        db.transaction(async (tx) => {
          await tx.delete(teams).where(eq(teams.id, f.own.teamId));
          expect(
            (
              await tx.execute(
                sql`SELECT 1 FROM public.invoice_refund_requests WHERE id=${id}::uuid`,
              )
            ).rows,
          ).toHaveLength(0);
          throw new Error("terminal cascade rehearsal rollback");
        }),
      ).rejects.toThrow("terminal cascade rehearsal rollback");
    });

    test("an expired reservation cannot backdate a dispatch or use a fresh application clock", async () => {
      const initial = await historicalReserved(-10);
      expect(initial.replayRemainingMs).toBe(0);
      await assertGuard(
        sql`UPDATE public.invoice_refund_requests SET state='unknown',attempt_count=1,
      first_attempt_at=created_at+interval '1 minute',last_attempt_at=created_at+interval '1 minute',
      claim_token=${randomUUID()}::uuid,claim_expires_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
      WHERE id=${initial.request.id}::uuid`,
        "outside its safe replay window",
      );
      const claim = await claimInvoiceRefundDispatch(db, {
        ...ownerScope(),
        requestId: initial.request.id,
        revision: initial.revision,
      });
      expect(claim.kind).toBe("blocked");
      expect((await plan(initial.request.id)).request.state).toBe(
        "manual_unknown",
      );
    });

    test("unknown intent actually expires under the database clock and restart never repeats POST", async () => {
      const initial = await historicalReserved(2);
      const claim = await claimInvoiceRefundDispatch(db, {
        ...ownerScope(),
        requestId: initial.request.id,
        revision: initial.revision,
      });
      if (claim.kind !== "dispatch")
        throw new Error("Fixture must claim inside its original replay window");
      await markInvoiceRefundDispatchUnknown(db, {
        ...scope(),
        requestId: initial.request.id,
        claimToken: claim.claimToken,
      });
      const limit = performance.now() + 4000;
      while (true) {
        const current = await plan(initial.request.id);
        if (refundReplayRemaining(current.request, current.databaseNow) === 0)
          break;
        if (performance.now() > limit)
          throw new Error(
            "Database fixture did not reach its immutable deadline",
          );
        await Bun.sleep(25);
      }
      const fake = provider(initial.request);
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        resumeDurableInvoiceRefund(db, fake.api, {
          ...ownerScope(),
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(fake.api.refunds.create).not.toHaveBeenCalled();
      expect((await plan(initial.request.id)).request).toMatchObject({
        state: "manual_unknown",
        attemptCount: 1,
        providerRefundId: null,
      });
    }, 10000);

    test("cross-tenant actor or request scope cannot prepare, dispatch or apply", async () => {
      await expect(
        prepareInvoiceRefundRequest(db, {
          ...ownerScope(),
          actorId: f.other.userId,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      const initial = await prepare();
      await expect(
        getInvoiceRefundRequestPlan(db, {
          invoiceId: f.other.invoiceId,
          teamId: f.other.teamId,
          actorId: f.other.userId,
          requestId: initial.request.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
      const proof = resource(initial.request, { teamId: f.other.teamId });
      const retained = await retainInvoiceRefundResource(db, {
        ...scope(),
        requestId: initial.request.id,
        revision: initial.revision,
        resource: proof,
      });
      expect(retained.applicableRevision).toBeNull();
      expect(retained.request.state).toBe("manual_unknown");
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
    });
  },
);
