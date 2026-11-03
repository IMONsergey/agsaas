import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InvoicePaymentError } from "@midday/db/errors";
import { createCallerFactory } from "../../trpc/init";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const providerProofs = [
  {
    source: "resource_get" as const,
    paymentIntentId: "pi_fixture",
    stripeAccountId: "acct_fixture",
    amountMinor: 10000,
    currency: "usd",
    refunds: [
      {
        id: "re_fixture",
        amountMinor: 2000,
        status: "succeeded",
        verifiedBy: "resource_get" as const,
      },
    ],
  },
];
const verifyResources = mock(
  async (_stripe: unknown, _plan: unknown) => providerProofs,
);
mock.module("@api/services/invoice-provider-reconciliation", () => ({
  getInvoiceProviderReconciliationProofs: verifyResources,
}));
const { invoicePaymentsRouter } = await import(
  "../../trpc/routers/invoice-payments"
);

const caller = () =>
  createCallerFactory(invoicePaymentsRouter)(createTestContext());
const input = {
  invoiceId: "73edc15c-7f58-42ca-9b25-ad0319f0bd10",
  operationId: "25e47cd2-703e-4738-8bee-881669c47aef",
  kind: "payment" as const,
  amountMinor: "4000",
  currency: "usd",
  occurredAt: "2026-11-01T12:00:00.000Z",
  reason: "Confirmed bank transfer",
  confirmed: true as const,
};
beforeEach(() => {
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
  mocks.recordInvoiceSettlement.mockClear();
  mocks.reconcileInvoiceSettlement.mockClear();
  mocks.getInvoiceProviderReconciliationPlan.mockReset();
  mocks.getInvoiceProviderReconciliationPlan.mockImplementation(
    async () => null,
  );
  mocks.applyInvoiceProviderReconciliation.mockReset();
  mocks.applyInvoiceProviderReconciliation.mockImplementation(async () => ({
    state: "verified",
    changed: true,
  }));
  verifyResources.mockReset();
  verifyResources.mockImplementation(async () => providerProofs);
});

describe("provider reconciliation API authority", () => {
  const plan = {
    invoiceId: input.invoiceId,
    teamId: "test-team-id",
    revision: "a".repeat(64),
    payments: [
      {
        paymentIntentId: "pi_fixture",
        stripeAccountId: "acct_fixture",
        amountMinor: 10000,
        currency: "usd",
        refunds: [{ id: "re_fixture", amountMinor: 2000, reversed: false }],
      },
    ],
  };
  const request = {
    invoiceId: input.invoiceId,
    apply: true,
    verifyProvider: true,
  };
  test("binds fresh verification and commit to the authenticated actor and captured revision", async () => {
    mocks.getInvoiceProviderReconciliationPlan.mockImplementation(
      async () => plan,
    );
    expect(await caller().reconcileSettlement(request)).toEqual({
      state: "verified",
      changed: true,
    });
    expect(mocks.getInvoiceProviderReconciliationPlan).toHaveBeenCalledWith(
      expect.anything(),
      {
        invoiceId: input.invoiceId,
        teamId: "test-team-id",
        actorId: "test-user-id",
      },
    );
    expect(verifyResources).toHaveBeenCalledWith(expect.anything(), plan);
    expect(mocks.applyInvoiceProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      {
        invoiceId: input.invoiceId,
        teamId: "test-team-id",
        actorId: "test-user-id",
        revision: plan.revision,
        proofs: providerProofs,
      },
    );
    expect(mocks.reconcileInvoiceSettlement).not.toHaveBeenCalled();
  });
  test("does not contact Stripe when there is no provider marker", async () => {
    expect(await caller().reconcileSettlement(request)).toEqual({
      state: "consistent",
      changed: false,
    });
    expect(verifyResources).not.toHaveBeenCalled();
    expect(mocks.applyInvoiceProviderReconciliation).not.toHaveBeenCalled();
  });
  test("a member cannot prepare or submit verification", async () => {
    mocks.getTeamMemberRole.mockImplementation(async () => "member");
    await expect(caller().reconcileSettlement(request)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.getInvoiceProviderReconciliationPlan).not.toHaveBeenCalled();
    expect(verifyResources).not.toHaveBeenCalled();
    expect(mocks.applyInvoiceProviderReconciliation).not.toHaveBeenCalled();
  });
  test("verification requires explicit apply and does not accept a supplied proof payload", async () => {
    await expect(
      caller().reconcileSettlement({ ...request, apply: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const forged = {
      ...request,
      revision: plan.revision,
      proofs: providerProofs,
    };
    await expect(caller().reconcileSettlement(forged)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.getInvoiceProviderReconciliationPlan).not.toHaveBeenCalled();
    expect(verifyResources).not.toHaveBeenCalled();
  });
  test("provider failure cannot clear the marker or fall back to a local rebuild", async () => {
    mocks.getInvoiceProviderReconciliationPlan.mockImplementation(
      async () => plan,
    );
    verifyResources.mockImplementation(async () => {
      throw new InvoicePaymentError(503, "Fixture provider unavailable");
    });
    await expect(caller().reconcileSettlement(request)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(mocks.applyInvoiceProviderReconciliation).not.toHaveBeenCalled();
    expect(mocks.reconcileInvoiceSettlement).not.toHaveBeenCalled();
  });
  test("a demotion at the final transaction remains FORBIDDEN after the GET completes", async () => {
    mocks.getInvoiceProviderReconciliationPlan.mockImplementation(
      async () => plan,
    );
    mocks.applyInvoiceProviderReconciliation.mockImplementation(async () => {
      throw new InvoicePaymentError(403, "Fixture owner demoted");
    });
    await expect(caller().reconcileSettlement(request)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(verifyResources).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileInvoiceSettlement).not.toHaveBeenCalled();
  });
});
describe("manual settlement API authority", () => {
  test("a demotion rejected inside the financial transaction remains FORBIDDEN", async () => {
    mocks.recordInvoiceSettlement.mockImplementationOnce(() =>
      Promise.reject(
        new InvoicePaymentError(
          403,
          "A current workspace owner must confirm settlement",
        ),
      ),
    );
    await expect(caller().recordSettlement(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  test("repair receives the authenticated actor rather than caller identity", async () => {
    await caller().reconcileSettlement({
      invoiceId: input.invoiceId,
      apply: true,
    });
    expect(mocks.reconcileInvoiceSettlement.mock.calls[0]?.[1]).toMatchObject({
      invoiceId: input.invoiceId,
      teamId: "test-team-id",
      actorId: "test-user-id",
      apply: true,
    });
  });

  test("records the authenticated actor/team and stable operation key", async () => {
    await caller().recordSettlement(input);
    await caller().recordSettlement(input);
    expect(mocks.recordInvoiceSettlement).toHaveBeenCalledTimes(2);
    const a = mocks.recordInvoiceSettlement.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    const b = mocks.recordInvoiceSettlement.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(a).toMatchObject({
      invoiceId: input.invoiceId,
      teamId: "test-team-id",
      actorId: "test-user-id",
      provider: "manual",
      amountMinor: "4000",
    });
    expect(a.operationKey).toBe(b.operationKey);
  });
  test("a member cannot record money or repair a projection", async () => {
    mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("member"));
    await expect(caller().recordSettlement(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller().reconcileSettlement({ invoiceId: input.invoiceId, apply: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.recordInvoiceSettlement).not.toHaveBeenCalled();
    expect(mocks.reconcileInvoiceSettlement).not.toHaveBeenCalled();
  });
  test("unconfirmed/fractional money and caller-supplied team identity never reach the journal", async () => {
    for (const invalid of [
      { ...input, confirmed: false },
      { ...input, amountMinor: "1.5" },
      { ...input, teamId: "foreign-team" },
    ])
      await expect(
        caller().recordSettlement(invalid as typeof input),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.recordInvoiceSettlement).not.toHaveBeenCalled();
  });
});
