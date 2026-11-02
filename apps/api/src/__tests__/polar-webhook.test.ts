import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  type BillingProduct,
  parseBillingSubscriptionEvent,
} from "@midday/db/billing-subscription";
import type { Context } from "../rest/types";

const environmentNames = [
  "POLAR_WEBHOOK_SECRET",
  "POLAR_STARTER_PRODUCT_ID",
  "POLAR_STARTER_YEARLY_PRODUCT_ID",
  "POLAR_PRO_PRODUCT_ID",
  "POLAR_PRO_YEARLY_PRODUCT_ID",
] as const;
const previousEnvironment = new Map(
  environmentNames.map((name) => [name, process.env[name]]),
);
const applyVerified = async (
  _db: unknown,
  input: { event: unknown; products: readonly BillingProduct[] },
) => {
  const parsed = parseBillingSubscriptionEvent(input.event, input.products);
  return parsed
    ? { state: "applied" as const, ...parsed }
    : { state: "unsupported" as const };
};
const apply = mock(applyVerified);
const job = mock(async () => {
  throw new Error("Redis unavailable");
});
const owner = mock(async () => ({
  email: "owner@example.test",
  fullName: "Fixture owner",
}));
const team = mock(async () => ({ name: "Fixture team" }));
const validate = mock(
  (_body: string, _headers: unknown, _secret: string): any => {
    throw new Error("Invalid JSON");
  },
);
class FixtureVerificationError extends Error {}
mock.module("@polar-sh/sdk/webhooks", () => ({
  validateEvent: validate,
  WebhookVerificationError: FixtureVerificationError,
}));
mock.module("@midday/db/queries", () => ({
  applyBillingSubscriptionEvent: apply,
  getTeamById: team,
  getTeamOwnerContact: owner,
}));
mock.module("@midday/job-client", () => ({ triggerJob: job }));
const { polarWebhookRouter } = await import("../rest/routers/webhooks/polar");
const app = new OpenAPIHono<Context>();
app.use("*", async (c, next) => {
  c.set("db", {} as Context["Variables"]["db"]);
  await next();
});
app.route("/polar", polarWebhookRouter);
const teamId = "5c214e53-7c33-461e-afbb-46ead597c688";
const event = {
  type: "subscription.revoked",
  data: {
    id: "subscription-fixture",
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    modifiedAt: new Date("2026-11-01T10:00:00.000Z"),
    status: "canceled",
    productId: "own-product",
    cancelAtPeriodEnd: false,
    customerId: "customer-fixture",
    customer: { id: "customer-fixture", externalId: teamId },
    metadata: { teamId },
  },
};
function request() {
  return app.request("/polar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}
beforeEach(() => {
  for (const name of environmentNames) delete process.env[name];
  process.env.POLAR_WEBHOOK_SECRET = "fixture-secret";
  process.env.POLAR_PRO_PRODUCT_ID = "own-product";
  apply.mockReset();
  apply.mockImplementation(applyVerified);
  job.mockClear();
  owner.mockClear();
  team.mockClear();
  validate.mockClear();
  validate.mockImplementation(() => {
    throw new Error("Payload parsing failed");
  });
});
afterAll(() => {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
describe("billing webhook verification boundary", () => {
  test("does not interpret a raw JSON payload after a non-signature verification failure", async () => {
    expect((await request()).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
  });
  test("rejects an invalid signature without applying entitlements", async () => {
    validate.mockImplementation(() => {
      throw new FixtureVerificationError("Invalid signature");
    });
    expect((await request()).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });
  test("passes an SDK-verified final revocation to the ordered entitlement helper", async () => {
    validate.mockImplementation(() => event);
    expect((await request()).status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.anything(), {
      event,
      products: expect.arrayContaining([{ id: "own-product", plan: "pro" }]),
    });
    expect(job).not.toHaveBeenCalled();
  });
  test("an unavailable signing secret never falls back to trusting the body", async () => {
    delete process.env.POLAR_WEBHOOK_SECRET;
    expect((await request()).status).toBe(500);
    expect(validate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  test("rejects missing resource time and an unrelated customer even after signature verification", async () => {
    for (const change of [
      { modifiedAt: null },
      { createdAt: null },
      { customer: { id: "customer-fixture", externalId: "another-team" } },
    ]) {
      validate.mockImplementation(() => ({
        ...event,
        data: { ...event.data, ...change },
      }));
      expect((await request()).status).toBe(400);
    }
    expect(job).not.toHaveBeenCalled();
  });
  test("rejects events for products not owned by this installation", async () => {
    validate.mockImplementation(() => ({
      ...event,
      data: { ...event.data, productId: "upstream-product" },
    }));
    expect((await request()).status).toBe(400);
    expect(job).not.toHaveBeenCalled();
  });
  test("past-due acknowledgement depends on the atomic SQL helper, not Redis or post-commit owner reads", async () => {
    validate.mockImplementation(() => ({
      ...event,
      type: "subscription.past_due",
      data: { ...event.data, status: "past_due" },
    }));
    expect((await request()).status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(job).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
    expect(team).not.toHaveBeenCalled();
  });
  test("failed atomic intent preparation returns retryable failure and the same verified event may retry", async () => {
    validate.mockImplementation(() => ({
      ...event,
      type: "subscription.past_due",
      data: { ...event.data, status: "past_due" },
    }));
    apply.mockImplementationOnce(async () => {
      throw new Error("Billing notification intent could not be retained");
    });
    expect((await request()).status).toBe(500);
    expect((await request()).status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(job).not.toHaveBeenCalled();
  });
});
