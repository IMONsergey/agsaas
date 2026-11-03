import { describe, expect, test } from "bun:test";
import {
  type InvoiceRefundRequest,
  REFUND_REPLAY_WINDOW_MS,
  refundReplayRemaining,
} from "./invoice-refund-request";

const request: InvoiceRefundRequest = {
  id: "87a2303c-6247-465f-9ea5-a052711af329",
  teamId: "60a8044f-8b55-4458-a563-035af33a8184",
  invoiceId: "c2726dd8-2f8e-424c-a3b5-afd6056d8eeb",
  paymentEntryId: "960459ac-1b28-4754-be5e-309b978dba78",
  operationId: "349a4705-bac0-43cd-b982-9094313159df",
  stripeAccountId: "acct_fixture",
  paymentIntentId: "pi_fixture",
  paymentAmountMinor: 10000,
  refundAmountMinor: 10000,
  currency: "usd",
  requestHash: "a".repeat(64),
  idempotencyKey: "invoice-refund/87a2303c-6247-465f-9ea5-a052711af329/v2",
  actorId: null,
  state: "unknown",
  providerRefundId: null,
  providerStatus: null,
  bindingVerified: false,
  createdAt: "2026-11-03T00:00:00Z",
  updatedAt: "2026-11-03T01:00:00Z",
  firstAttemptAt: "2026-11-03T01:00:00Z",
  lastAttemptAt: "2026-11-03T01:00:00Z",
  attemptCount: 1,
  claimToken: null,
  claimExpiresAt: null,
  failureCode: null,
};

describe("immutable refund replay age", () => {
  test("the safe window ends at 23 hours from creation, including a nearly new last attempt", () => {
    expect(REFUND_REPLAY_WINDOW_MS).toBe(23 * 60 * 60 * 1000);
    expect(refundReplayRemaining(request, "2026-11-03T22:59:59.999Z")).toBe(1);
    expect(refundReplayRemaining(request, "2026-11-03T23:00:00Z")).toBe(0);
    expect(
      refundReplayRemaining(
        { ...request, lastAttemptAt: "2026-11-03T22:59:59Z", attemptCount: 20 },
        "2026-11-03T23:00:00Z",
      ),
    ).toBe(0);
  });
  test("backward or invalid database clock never authorizes replay", () => {
    for (const clock of [
      "2026-11-03T00:59:59Z",
      "2026-11-02T00:00:00Z",
      "invalid",
    ])
      expect(refundReplayRemaining(request, clock)).toBe(0);
    expect(
      refundReplayRemaining(
        { ...request, lastAttemptAt: "2026-11-02T23:59:59Z" },
        "2026-11-03T01:00:00Z",
      ),
    ).toBe(0);
  });
  test("known provider identity or a blocked state cannot be reopened by a new process", () => {
    expect(
      refundReplayRemaining(
        { ...request, providerRefundId: "re_retained" },
        "2026-11-03T01:00:00Z",
      ),
    ).toBe(0);
    for (const state of [
      "bound",
      "settled",
      "failed",
      "manual_unknown",
    ] as const)
      expect(
        refundReplayRemaining({ ...request, state }, "2026-11-03T01:00:00Z"),
      ).toBe(0);
  });
});
