import { describe, expect, mock, test } from "bun:test";
import { reconcileBillingSubscription } from "../services/billing-reconciliation";
const teamId = "5c214e53-7c33-461e-afbb-46ead597c688";
function fixture() {
  const binding = { teamId, subscriptionId: "sub_fixture" };
  return {
    teamId,
    products: [{ id: "own-product", plan: "pro" as const }],
    readBinding: mock(async () => binding),
    readProvider: mock(
      async (_id: string): Promise<unknown> => ({
        id: "sub_fixture",
        createdAt: new Date("2026-11-01T09:00:00Z"),
        modifiedAt: new Date("2026-11-01T10:00:00Z"),
        customerId: "customer",
        customer: { id: "customer", externalId: teamId },
        metadata: { teamId },
        productId: "own-product",
        status: "active",
        cancelAtPeriodEnd: false,
      }),
    ),
    apply: mock(async (_event: unknown, _binding: unknown) => ({
      state: "applied",
    })),
  };
}
describe("billing reconciliation provider boundary", () => {
  test("loads only the stored ID and passes its exact fence to the SQL apply", async () => {
    const value = fixture();
    expect(await reconcileBillingSubscription(value)).toEqual({
      state: "applied",
    });
    expect(value.readProvider).toHaveBeenCalledWith("sub_fixture");
    expect(value.apply.mock.calls[0]?.[1]).toEqual({
      teamId,
      subscriptionId: "sub_fixture",
    });
  });
  test("an unbound legacy team does not search or guess a provider account", async () => {
    const value = fixture();
    const result = await reconcileBillingSubscription({
      ...value,
      readBinding: async () => null,
    });
    expect(result).toEqual({ state: "requires_binding" });
    expect(value.readProvider).not.toHaveBeenCalled();
    expect(value.apply).not.toHaveBeenCalled();
  });
  test("provider failure cannot mutate local entitlement", async () => {
    const value = fixture();
    value.readProvider.mockImplementation(async () => {
      throw new Error("provider unavailable");
    });
    await expect(reconcileBillingSubscription(value)).rejects.toThrow(
      "provider unavailable",
    );
    expect(value.apply).not.toHaveBeenCalled();
  });
  test("another provider resource cannot mutate the bound team", async () => {
    const value = fixture();
    value.readProvider.mockImplementation(async () => ({}));
    await expect(reconcileBillingSubscription(value)).rejects.toThrow();
    expect(value.apply).not.toHaveBeenCalled();
  });
});
