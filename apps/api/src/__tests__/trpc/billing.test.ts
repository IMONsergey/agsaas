import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { billingRouter } from "../../trpc/routers/billing";
import { createTestContext } from "../helpers/test-context";
import { mockDb, mocks } from "../setup";

const createCaller = createCallerFactory(billingRouter);

const billingEnv = {
  AGSAAS_BILLING_ENABLED: "true",
  POLAR_ACCESS_TOKEN: "fixture-private",
  POLAR_WEBHOOK_SECRET: "fixture-webhook",
  POLAR_STARTER_PRODUCT_ID: "own-starter-monthly",
  POLAR_STARTER_YEARLY_PRODUCT_ID: "own-starter-yearly",
  POLAR_PRO_PRODUCT_ID: "own-pro-monthly",
  POLAR_PRO_YEARLY_PRODUCT_ID: "own-pro-yearly",
  DASHBOARD_URL: "https://workspace.example.test",
};
const previousBillingEnv = Object.fromEntries(
  Object.keys(billingEnv).map((key) => [key, process.env[key]]),
);
beforeEach(() => {
  Object.assign(process.env, billingEnv);
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
  mocks.polarCheckoutCreate.mockClear();
  mocks.getTeamById.mockImplementation(() =>
    Promise.resolve({
      id: "test-team-id",
      name: "Test workspace",
      plan: "trial",
      subscriptionStatus: null,
    }),
  );
});
afterAll(() => {
  for (const [key, value] of Object.entries(previousBillingEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("tRPC: billing checkout isolation", () => {
  test("configured owners use only their installation's product and team identity", async () => {
    const caller = createCaller(createTestContext());
    expect(
      await caller.createCheckout({
        plan: "pro",
        planType: "pro_yearly",
        embedOrigin: "https://workspace.example.test",
      }),
    ).toEqual({ url: "https://polar.test/checkout" });
    expect(mocks.polarCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["own-pro-yearly"],
        externalCustomerId: "test-team-id",
        metadata: { teamId: "test-team-id" },
        embedOrigin: "https://workspace.example.test",
        allowTrial: false,
      }),
    );
  });
  test("an existing paid subscription must use the portal instead of a new checkout", async () => {
    mocks.getTeamById.mockImplementation(() =>
      Promise.resolve({
        id: "test-team-id",
        plan: "pro",
        subscriptionStatus: "active",
      }),
    );
    const caller = createCaller(createTestContext());
    await expect(
      caller.createCheckout({
        plan: "pro",
        embedOrigin: "https://workspace.example.test",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.polarCheckoutCreate).not.toHaveBeenCalled();
  });
  test("no provider call occurs before billing is configured", async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    const caller = createCaller(createTestContext());
    await expect(
      caller.createCheckout({
        plan: "pro",
        embedOrigin: "https://workspace.example.test",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.polarCheckoutCreate).not.toHaveBeenCalled();
  });
  test("members cannot start a subscription", async () => {
    mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("member"));
    const caller = createCaller(createTestContext());
    await expect(
      caller.createCheckout({
        plan: "pro",
        embedOrigin: "https://workspace.example.test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.polarCheckoutCreate).not.toHaveBeenCalled();
  });
  test("checkout rejects an unrelated origin", async () => {
    const caller = createCaller(createTestContext());
    await expect(
      caller.createCheckout({
        plan: "pro",
        embedOrigin: "https://external.example.test",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.polarCheckoutCreate).not.toHaveBeenCalled();
  });
});

describe("tRPC: billing.getActiveSubscription", () => {
  beforeEach(() => {
    mocks.polarSubscriptionsList.mockReset();
    mocks.polarSubscriptionsList.mockImplementation(() =>
      Promise.resolve({ result: { items: [] } }),
    );
  });

  test("returns null when Polar has no active subscription", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.getActiveSubscription()).toBeNull();
    expect(mocks.polarSubscriptionsList).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "polar-customer-id" }),
    );
  });

  test("returns null when Polar list throws", async () => {
    mocks.polarSubscriptionsList.mockRejectedValueOnce(new Error("polar down"));

    const caller = createCaller(createTestContext());
    expect(await caller.getActiveSubscription()).toBeNull();
  });
});

describe("tRPC: billing.cancelSubscription", () => {
  beforeEach(() => {
    mocks.polarSubscriptionsList.mockReset();
    mocks.polarSubscriptionsUpdate.mockReset();
    mocks.updateTeam.mockReset();
    mockDb.query.users.findFirst.mockReset();
    mockDb.query.users.findFirst.mockImplementation(() =>
      Promise.resolve({
        id: "test-user-id",
        teamId: "test-team-id",
        email: "test@example.com",
        usersOnTeams: [{ id: "membership-1", teamId: "test-team-id" }],
      }),
    );
    mocks.polarSubscriptionsUpdate.mockImplementation(() =>
      Promise.resolve({}),
    );
    mocks.updateTeam.mockImplementation(() => Promise.resolve({}));
  });

  test("cancels at period end and updates team via updateTeamById", async () => {
    mocks.polarSubscriptionsList.mockImplementation(() =>
      Promise.resolve({
        result: {
          items: [
            {
              id: "sub_1",
              status: "active",
              cancelAtPeriodEnd: false,
              productId: "prod_test",
              metadata: { teamId: "test-team-id" },
            },
          ],
        },
      }),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.cancelSubscription({
      reason: "too_expensive",
    });

    expect(result).toEqual({ success: true });
    expect(mocks.polarSubscriptionsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sub_1",
        subscriptionUpdate: expect.objectContaining({
          cancelAtPeriodEnd: true,
          customerCancellationReason: "too_expensive",
        }),
      }),
    );
    expect(mocks.updateTeam).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "test-team-id",
        data: { canceledAt: expect.any(String) },
      }),
    );
  });

  test("throws NOT_FOUND when there is no active or canceled subscription", async () => {
    mocks.polarSubscriptionsList.mockImplementation(() =>
      Promise.resolve({ result: { items: [] } }),
    );

    const caller = createCaller(createTestContext());
    await expect(
      caller.cancelSubscription({ reason: "too_expensive" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No active subscription found",
    });
    expect(mocks.polarSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mocks.updateTeam).not.toHaveBeenCalled();
  });
});
