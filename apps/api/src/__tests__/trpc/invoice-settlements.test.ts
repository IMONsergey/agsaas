import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { invoicePaymentsRouter } from "../../trpc/routers/invoice-payments";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";
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
});
describe("manual settlement API authority", () => {
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
