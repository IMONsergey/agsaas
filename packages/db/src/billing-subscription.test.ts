import { describe, expect, test } from "bun:test";
import {
  BillingSubscriptionEventError,
  parseBillingSubscriptionEvent,
} from "./billing-subscription";

const teamId = "5c214e53-7c33-461e-afbb-46ead597c688";
const products = [{ id: "own-product", plan: "pro" as const }];
const event = () => ({
  type: "subscription.active",
  data: {
    id: "subscription-fixture",
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    modifiedAt: new Date("2026-11-01T10:00:00.000Z"),
    customerId: "customer-fixture",
    customer: { id: "customer-fixture", externalId: teamId },
    metadata: { teamId },
    productId: "own-product",
    status: "active",
    cancelAtPeriodEnd: false,
  },
});

describe("SDK-verified billing event boundary", () => {
  test("uses the provider resource version and exact own product/team binding", () => {
    expect(parseBillingSubscriptionEvent(event(), products)).toEqual({
      teamId,
      subscriptionId: "subscription-fixture",
      createdAt: "2026-11-01T09:00:00.000Z",
      modifiedAt: "2026-11-01T10:00:00.000Z",
      plan: "pro",
      action: "active",
      cancelAtPeriodEnd: false,
      subscriptionStatus: "active",
    });
  });
  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["raw JSON timestamp", "2026-11-01T10:00:00.000Z"],
    ["invalid", new Date("invalid")],
  ] as const) {
    test(`rejects ${label} modifiedAt without using webhook or local time`, () => {
      const input = event();
      expect(() =>
        parseBillingSubscriptionEvent(
          { ...input, data: { ...input.data, modifiedAt: value } },
          products,
        ),
      ).toThrow(BillingSubscriptionEventError);
    });
  }
  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["raw JSON timestamp", "2026-11-01T09:00:00.000Z"],
    ["invalid", new Date("invalid")],
  ] as const) {
    test(`rejects ${label} resource createdAt without guessing subscription age`, () => {
      const input = event();
      expect(() =>
        parseBillingSubscriptionEvent(
          { ...input, data: { ...input.data, createdAt: value } },
          products,
        ),
      ).toThrow(BillingSubscriptionEventError);
    });
  }
  test("rejects a resource version before the subscription existed", () => {
    const input = event();
    expect(() =>
      parseBillingSubscriptionEvent(
        {
          ...input,
          data: {
            ...input.data,
            createdAt: new Date("2026-11-01T11:00:00.000Z"),
          },
        },
        products,
      ),
    ).toThrow(BillingSubscriptionEventError);
  });
  test("rejects another team's customer, an unbound customer and mismatching nested identity", () => {
    for (const customer of [
      { id: "customer-fixture", externalId: "other-team" },
      { id: "customer-fixture" },
      { id: "different", externalId: teamId },
    ]) {
      const input = event();
      expect(() =>
        parseBillingSubscriptionEvent(
          { ...input, data: { ...input.data, customer } },
          products,
        ),
      ).toThrow(BillingSubscriptionEventError);
    }
  });
  test("rejects empty/malformed subscription IDs and unknown or ambiguous product configuration", () => {
    for (const id of ["", "  subscription  ", "sub\nidentity", null]) {
      const input = event();
      expect(() =>
        parseBillingSubscriptionEvent(
          { ...input, data: { ...input.data, id } },
          products,
        ),
      ).toThrow(BillingSubscriptionEventError);
    }
    expect(() => parseBillingSubscriptionEvent(event(), [])).toThrow(
      BillingSubscriptionEventError,
    );
    expect(() =>
      parseBillingSubscriptionEvent(event(), [...products, ...products]),
    ).toThrow(BillingSubscriptionEventError);
  });
  test("ignores unrelated SDK-verified events", () => {
    expect(
      parseBillingSubscriptionEvent({ type: "order.paid", data: {} }, products),
    ).toBeNull();
  });
  test("a terminal canceled resource revokes access independently of webhook event order", () => {
    const input = event();
    for (const type of ["subscription.canceled", "subscription.revoked"]) {
      expect(
        parseBillingSubscriptionEvent(
          { ...input, type, data: { ...input.data, status: "canceled" } },
          products,
        )?.action,
      ).toBe("revoked");
    }
  });
});
