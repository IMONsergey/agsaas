import { describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InvoicePaymentError } from "@midday/db/errors";
import {
  type InvoiceRefundRequest,
  invoiceRefundRequestView,
  refundReplayRemaining,
  refundResourceMatches,
  refundStatus,
} from "@midday/db/invoice-refund-request";
import type Stripe from "stripe";
import {
  type DurableRefundProvider,
  type RefundRequestOperations,
  runInvoiceRefundRequest,
} from "../services/invoice-refund-engine";

type ProviderRefund = Awaited<
  ReturnType<DurableRefundProvider["refunds"]["retrieve"]>
>;
function fixture(overrides: Partial<InvoiceRefundRequest> = {}) {
  const original: InvoiceRefundRequest = {
    id: "1e5e1319-1041-4c96-80a0-189fdab6de3c",
    teamId: "c6ef5132-6e6b-4b31-8628-0f3c4d52ec9b",
    invoiceId: "d011b803-cf8d-4aa0-9a91-6892e0723cc1",
    paymentEntryId: "ff94768d-6fb3-4493-b643-398f5c5079af",
    operationId: "f1ec0584-63be-493a-a37d-e79069d925c3",
    stripeAccountId: "acct_original",
    paymentIntentId: "pi_original",
    paymentAmountMinor: 12005,
    refundAmountMinor: 12005,
    currency: "usd",
    requestHash: "a".repeat(64),
    idempotencyKey: "invoice-refund/1e5e1319-1041-4c96-80a0-189fdab6de3c/v2",
    actorId: "0e07c7b7-a770-4482-8806-088b758fb8a6",
    state: "reserved",
    providerRefundId: null,
    providerStatus: null,
    bindingVerified: false,
    createdAt: "2026-11-03T10:00:00Z",
    updatedAt: "2026-11-03T10:00:00Z",
    firstAttemptAt: null,
    lastAttemptAt: null,
    attemptCount: 0,
    claimToken: null,
    claimExpiresAt: null,
    failureCode: null,
    ...overrides,
  };
  const memory = {
    request: original,
    revision: 1,
    databaseNow: "2026-11-03T10:01:00Z",
    owner: true,
    retainFailure: false,
    forceStale: false,
    ledgerWrites: 0,
    events: [] as string[],
  };
  const owner = () => {
    if (!memory.owner)
      throw new InvoicePaymentError(403, "Owner permission changed");
  };
  const revision = () => `revision-${memory.revision}`;
  const operations: RefundRequestOperations = {
    load: async () => {
      owner();
      memory.events.push("load");
      return {
        request: { ...memory.request },
        revision: revision(),
        databaseNow: memory.databaseNow,
        replayRemainingMs: refundReplayRemaining(
          memory.request,
          memory.databaseNow,
        ),
      };
    },
    claim: async (expected) => {
      owner();
      memory.events.push("claim");
      if (expected !== revision())
        throw new InvoicePaymentError(409, "Concurrent state change");
      if (memory.request.providerRefundId)
        return { kind: "known", request: { ...memory.request } };
      const remainingMs = refundReplayRemaining(
        memory.request,
        memory.databaseNow,
      );
      if (!remainingMs)
        return { kind: "blocked", request: { ...memory.request } };
      if (
        memory.request.claimToken &&
        Date.parse(memory.request.claimExpiresAt!) >
          Date.parse(memory.databaseNow)
      )
        return { kind: "busy", request: { ...memory.request } };
      memory.request = {
        ...memory.request,
        state: "unknown",
        attemptCount: memory.request.attemptCount + 1,
        firstAttemptAt: memory.request.firstAttemptAt ?? memory.databaseNow,
        lastAttemptAt: memory.databaseNow,
        claimToken: randomUUID(),
        claimExpiresAt: new Date(
          Date.parse(memory.databaseNow) + 30_000,
        ).toISOString(),
      };
      memory.revision++;
      return {
        kind: "dispatch",
        request: { ...memory.request },
        revision: revision(),
        remainingMs,
        claimToken: memory.request.claimToken!,
      };
    },
    retain: async (expected, resource) => {
      memory.events.push("retain");
      if (memory.retainFailure)
        throw new Error("process stopped before receipt commit");
      const applicable =
        expected === revision() &&
        !memory.forceStale &&
        refundResourceMatches(memory.request, resource);
      memory.request = {
        ...memory.request,
        providerRefundId: resource.id,
        providerStatus: refundStatus(resource.status),
        bindingVerified: refundResourceMatches(memory.request, resource),
        claimToken: null,
        claimExpiresAt: null,
        state:
          refundStatus(resource.status) &&
          refundResourceMatches(memory.request, resource)
            ? "bound"
            : "manual_unknown",
      };
      memory.revision++;
      return {
        request: { ...memory.request },
        applicableRevision: applicable ? revision() : null,
      };
    },
    apply: async (expected, resource) => {
      owner();
      memory.events.push("apply");
      if (expected !== revision())
        throw new InvoicePaymentError(409, "Concurrent state change");
      if (resource.source !== "resource_get")
        throw new Error("Only exact GET evidence may apply money");
      const status = refundStatus(resource.status);
      if (status === "succeeded") memory.ledgerWrites++;
      memory.request = {
        ...memory.request,
        state:
          status === "succeeded"
            ? "settled"
            : status === "failed" || status === "canceled"
              ? "failed"
              : status
                ? "bound"
                : "manual_unknown",
      };
      memory.revision++;
      return invoiceRefundRequestView(memory.request);
    },
    unknown: async (claimToken) => {
      memory.events.push("unknown");
      if (claimToken === memory.request.claimToken) {
        memory.request = {
          ...memory.request,
          failureCode: "provider_outcome_unknown",
        };
        memory.revision++;
      }
    },
    view: async () => {
      owner();
      memory.events.push("view");
      return invoiceRefundRequestView(memory.request);
    },
  };
  const refunds = new Map<string, ProviderRefund>();
  const refund = (changes: Partial<ProviderRefund> = {}): ProviderRefund => ({
    id: "re_original",
    status: "pending",
    amount: original.refundAmountMinor,
    currency: original.currency,
    payment_intent: original.paymentIntentId,
    metadata: {
      invoice_id: original.invoiceId,
      team_id: original.teamId,
      invoice_refund_request_id: original.id,
    },
    ...changes,
  });
  const provider = {
    paymentIntents: {
      retrieve: mock(async (_id: string, _options: Stripe.RequestOptions) => {
        memory.events.push("payment-get");
        return {
          id: original.paymentIntentId,
          amount: original.paymentAmountMinor,
          amount_received: original.paymentAmountMinor,
          currency: original.currency,
          status: "succeeded" as const,
          metadata: {
            invoice_id: original.invoiceId,
            team_id: original.teamId,
          },
        };
      }),
    },
    refunds: {
      list: mock(
        async (
          _params: Stripe.RefundListParams,
          _options: Stripe.RequestOptions,
        ) => {
          memory.events.push("refund-list");
          return { data: [...refunds.values()], has_more: false };
        },
      ),
      retrieve: mock(async (id: string, _options: Stripe.RequestOptions) => {
        memory.events.push("refund-get");
        const value = refunds.get(id);
        if (!value) throw new Error("resource_missing");
        return value;
      }),
      create: mock(
        async (
          _params: Stripe.RefundCreateParams,
          _options: Stripe.RequestOptions,
        ) => {
          memory.events.push("post");
          const value = refund();
          refunds.set(value.id, value);
          return value;
        },
      ),
    },
  } satisfies DurableRefundProvider;
  return { original, memory, operations, provider, refunds, refund };
}

describe("durable invoice refund orchestration with fake provider and persisted request seam", () => {
  test("POST follows a committed unknown claim and uses the frozen amount, metadata and key", async () => {
    const f = fixture();
    f.provider.refunds.create.mockImplementation(async (params, options) => {
      expect(f.memory.request.state).toBe("unknown");
      expect(f.memory.request.attemptCount).toBe(1);
      expect(f.memory.request.claimToken).not.toBeNull();
      expect(params).toEqual({
        payment_intent: "pi_original",
        amount: 12005,
        metadata: {
          invoice_id: f.original.invoiceId,
          team_id: f.original.teamId,
          invoice_refund_request_id: f.original.id,
        },
      });
      expect(options).toMatchObject({
        stripeAccount: "acct_original",
        idempotencyKey: f.original.idempotencyKey,
      });
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(5000);
      f.memory.events.push("post");
      return f.refund({ status: "succeeded" });
    });
    expect(
      await runInvoiceRefundRequest(f.provider, f.operations),
    ).toMatchObject({ state: "bound", status: "requested" });
    expect(f.memory.ledgerWrites).toBe(0);
    expect(f.memory.events).toEqual([
      "load",
      "payment-get",
      "refund-list",
      "claim",
      "post",
      "retain",
      "view",
    ]);
  });

  for (const failure of [
    "timeout",
    "HTTP 500",
    "HTTP 502",
    "HTTP 400 after earlier unknown attempt",
  ]) {
    test(`${failure} keeps unknown outcome and a restart uses the same key and amount`, async () => {
      const f = fixture();
      f.provider.refunds.create.mockImplementation(async () => {
        throw new Error(failure);
      });
      await expect(
        runInvoiceRefundRequest(f.provider, f.operations),
      ).rejects.toMatchObject({ status: 503 });
      expect(f.memory.request).toMatchObject({
        state: "unknown",
        providerRefundId: null,
        createdAt: f.original.createdAt,
      });
      const first = f.memory.request.firstAttemptAt;
      const firstArgs = f.provider.refunds.create.mock.calls[0];
      f.memory.databaseNow = "2026-11-03T10:02:00Z";
      f.provider.refunds.create.mockImplementation(async () => f.refund());
      await runInvoiceRefundRequest(f.provider, f.operations);
      expect(f.provider.refunds.create.mock.calls[1]?.[0]).toEqual(
        firstArgs?.[0],
      );
      expect(f.provider.refunds.create.mock.calls[1]?.[1]?.idempotencyKey).toBe(
        firstArgs?.[1]?.idempotencyKey,
      );
      expect(f.memory.request.firstAttemptAt).toBe(first);
      expect(f.memory.request.createdAt).toBe(f.original.createdAt);
    });
  }

  test("crash after POST before persisting ID recovers by metadata and exact GET without another POST", async () => {
    const f = fixture();
    f.memory.retainFailure = true;
    f.provider.refunds.create.mockImplementation(async () => {
      const resource = f.refund({ status: "succeeded" });
      f.refunds.set(resource.id, resource);
      return resource;
    });
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.memory.request).toMatchObject({
      state: "unknown",
      providerRefundId: null,
    });
    f.memory.retainFailure = false;
    expect(
      await runInvoiceRefundRequest(f.provider, f.operations),
    ).toMatchObject({ status: "confirmed" });
    expect(f.provider.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.provider.refunds.retrieve).toHaveBeenCalledWith("re_original", {
      stripeAccount: "acct_original",
      timeout: expect.any(Number),
    });
    expect(f.memory.ledgerWrites).toBe(1);
  });

  for (const state of [
    "bound",
    "manual_unknown",
    "settled",
    "failed",
  ] as const) {
    test(`a retained provider ID in ${state} always uses GET, never POST or list`, async () => {
      const status =
        state === "settled"
          ? "succeeded"
          : state === "failed"
            ? "failed"
            : "pending";
      const f = fixture({
        state,
        providerRefundId: "re_original",
        bindingVerified: true,
        providerStatus: status,
      });
      f.refunds.set("re_original", f.refund({ status }));
      await runInvoiceRefundRequest(f.provider, f.operations);
      expect(f.provider.refunds.retrieve).toHaveBeenCalledTimes(1);
      expect(f.provider.refunds.create).not.toHaveBeenCalled();
      expect(f.provider.refunds.list).not.toHaveBeenCalled();
    });
  }

  test("resource_missing for a retained ID never falls back to create", async () => {
    const f = fixture({
      state: "bound",
      providerRefundId: "re_original",
      bindingVerified: true,
      providerStatus: "pending",
    });
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.provider.refunds.create).not.toHaveBeenCalled();
    expect(f.provider.refunds.list).not.toHaveBeenCalled();
    expect(f.memory.request.providerRefundId).toBe("re_original");
  });

  test("expired unknown request survives a restart and empty provider history never authorizes POST", async () => {
    const f = fixture({
      state: "unknown",
      attemptCount: 1,
      firstAttemptAt: "2026-11-03T10:00:00Z",
      lastAttemptAt: "2026-11-03T10:00:00Z",
    });
    f.memory.databaseNow = "2026-11-04T09:00:00Z";
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.memory.request.state).toBe("unknown");
    expect(f.provider.refunds.create).not.toHaveBeenCalled();
    expect(f.memory.ledgerWrites).toBe(0);
  });

  test("expired unknown request may still recover positive exact evidence", async () => {
    const f = fixture({
      state: "manual_unknown",
      attemptCount: 1,
      firstAttemptAt: "2026-11-03T10:00:00Z",
      lastAttemptAt: "2026-11-03T10:00:00Z",
    });
    f.memory.databaseNow = "2026-11-05T09:00:00Z";
    f.refunds.set("re_original", f.refund({ status: "succeeded" }));
    expect(
      await runInvoiceRefundRequest(f.provider, f.operations),
    ).toMatchObject({ status: "confirmed" });
    expect(f.provider.refunds.create).not.toHaveBeenCalled();
  });

  test("demotion during preflight prevents dispatch", async () => {
    const f = fixture();
    f.provider.refunds.list.mockImplementation(async () => {
      f.memory.owner = false;
      return { data: [], has_more: false };
    });
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.provider.refunds.create).not.toHaveBeenCalled();
    expect(f.memory.request.state).toBe("reserved");
  });

  test("demotion after dispatch still retains the receipt before denying owner acknowledgment", async () => {
    const f = fixture();
    f.provider.refunds.create.mockImplementation(async () => {
      f.memory.owner = false;
      return f.refund();
    });
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.memory.request).toMatchObject({
      providerRefundId: "re_original",
      state: "bound",
    });
    expect(f.memory.ledgerWrites).toBe(0);
  });

  test("demotion during exact GET retains identity but denies financial apply", async () => {
    const f = fixture({
      state: "bound",
      providerRefundId: "re_original",
      bindingVerified: true,
      providerStatus: "pending",
    });
    f.provider.refunds.retrieve.mockImplementation(async () => {
      f.memory.owner = false;
      return f.refund({ status: "succeeded" });
    });
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.memory.request.providerRefundId).toBe("re_original");
    expect(f.memory.ledgerWrites).toBe(0);
  });

  for (const status of [null, "future_provider_status"]) {
    test(`unknown status ${status} preserves a discovered ID and never confirms money`, async () => {
      const f = fixture({
        state: "unknown",
        attemptCount: 1,
        firstAttemptAt: "2026-11-03T10:00:00Z",
        lastAttemptAt: "2026-11-03T10:00:00Z",
      });
      f.refunds.set("re_original", f.refund({ status }));
      expect(
        await runInvoiceRefundRequest(f.provider, f.operations),
      ).toMatchObject({ status: "reconciliation_required" });
      expect(f.memory.request).toMatchObject({
        state: "manual_unknown",
        providerRefundId: "re_original",
      });
      expect(f.memory.ledgerWrites).toBe(0);
      expect(f.provider.refunds.create).not.toHaveBeenCalled();
    });
  }

  test("stale proof retains the observed ID but cannot apply money", async () => {
    const f = fixture();
    f.memory.forceStale = true;
    f.refunds.set("re_original", f.refund({ status: "succeeded" }));
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.memory.request.providerRefundId).toBe("re_original");
    expect(f.memory.ledgerWrites).toBe(0);
    expect(f.memory.events).not.toContain("apply");
  });

  test("another unsettled refund or changed refundable balance prevents a new POST", async () => {
    const f = fixture();
    f.refunds.set(
      "re_other",
      f.refund({ id: "re_other", metadata: {}, amount: 1 }),
    );
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.provider.refunds.create).not.toHaveBeenCalled();
    expect(f.memory.events).not.toContain("claim");
  });

  test("provider metadata collision or changed amount refuses positive recovery", async () => {
    const f = fixture();
    f.refunds.set("re_original", f.refund({ amount: 12004 }));
    await expect(
      runInvoiceRefundRequest(f.provider, f.operations),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.provider.refunds.create).not.toHaveBeenCalled();
    expect(f.memory.request.providerRefundId).toBeNull();
  });

  test("claim latency cannot carry a POST beyond its remaining replay window", async () => {
    const f = fixture();
    f.memory.databaseNow = "2026-11-04T08:59:59.999Z";
    let monotonic = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => monotonic);
    const claim = f.operations.claim;
    f.operations.claim = async (value) => {
      const result = await claim(value);
      monotonic += 2;
      return result;
    };
    try {
      await expect(
        runInvoiceRefundRequest(f.provider, f.operations),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.provider.refunds.create).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
