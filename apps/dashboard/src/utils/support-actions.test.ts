import { beforeEach, describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { z } from "zod";

const received: unknown[] = [];
let fail = false;
const receipt = {
  accepted: true,
  id: "33333333-3333-4333-8333-333333333333",
  status: "received",
};
mock.module("@/trpc/server", () => ({
  getTRPCClient: async () => ({
    support: {
      submit: {
        mutate: async (value: unknown) => {
          received.push(value);
          if (fail)
            throw new Error("PRIVATE_PROVIDER_DETAIL secret credential");
          return receipt;
        },
      },
    },
  }),
}));
mock.module("@/actions/safe-action", () => ({
  authActionClient: {
    schema: (schema: z.ZodType) => ({
      metadata: () => ({
        action:
          (handler: (args: { parsedInput: unknown }) => Promise<unknown>) =>
          async (input: unknown) =>
            handler({ parsedInput: schema.parse(input) }),
      }),
    }),
  },
}));
const { sendSupportAction } = await import("../actions/send-support-action");
const { sendFeebackAction } = await import("../actions/send-feedback-action");
// Exercise the public input boundary, including deliberately invalid inputs.
const support = sendSupportAction as (value: unknown) => Promise<unknown>;
const feedback = sendFeebackAction as (value: unknown) => Promise<unknown>;
const requestId = "11111111-1111-4111-8111-111111111111";
const valid = {
  requestId,
  subject: " Help ",
  priority: "high",
  type: "General",
  message: " Keep my text ",
};
beforeEach(() => {
  received.length = 0;
  fail = false;
});
describe("own durable support actions", () => {
  test("returns only the receipt from the authenticated own API", async () => {
    assert.deepEqual(await support(valid), receipt);
    assert.deepEqual(received, [
      { ...valid, subject: "Help", message: "Keep my text" },
    ]);
  });
  test("feedback uses the same own durable queue and stable request identity", async () => {
    assert.deepEqual(
      await feedback({ requestId, feedback: " Feedback text " }),
      receipt,
    );
    assert.deepEqual(received, [
      {
        requestId,
        subject: "Feedback",
        priority: "low",
        type: "General",
        message: "Feedback text",
      },
    ]);
  });
  test.each([
    "low",
    "normal",
    "high",
    "urgent",
  ])("preserves selected priority %s", async (priority) => {
    await support({ ...valid, priority });
    assert.equal((received[0] as typeof valid).priority, priority);
  });
  test("rejects missing identity, invalid categories and empty/oversized content before API calls", async () => {
    for (const input of [
      { ...valid, requestId: undefined },
      { ...valid, requestId: "arbitrary" },
      { ...valid, subject: " " },
      { ...valid, subject: "x".repeat(201) },
      { ...valid, message: " " },
      { ...valid, message: "x".repeat(10001) },
      { ...valid, priority: "unreviewed" },
      { ...valid, type: "arbitrary" },
    ])
      await assert.rejects(support(input));
    for (const input of [
      { requestId, feedback: "" },
      { requestId, feedback: "x".repeat(10001) },
    ])
      await assert.rejects(feedback(input));
    assert.equal(received.length, 0);
  });
  test("does not forward client-supplied identity or arbitrary page URLs", async () => {
    await support({
      ...valid,
      userId: "another-user",
      teamId: "another-team",
      email: "other@example.test",
      url: "https://secret:password@example.test",
    });
    assert.deepEqual(received[0], {
      ...valid,
      subject: "Help",
      message: "Keep my text",
    });
  });
  test("keeps ambiguous outcomes safe and passes the same reference on retry", async () => {
    fail = true;
    await assert.rejects(support(valid), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(
        error.message,
        "Receipt could not be confirmed. Your text is preserved; retry with the same reference.",
      );
      return true;
    });
    fail = false;
    assert.deepEqual(await support(valid), receipt);
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], received[1]);
  });
  test("feedback errors also conceal diagnostics and retain retry semantics", async () => {
    fail = true;
    await assert.rejects(
      feedback({ requestId, feedback: "unchanged" }),
      /retry with the same reference/,
    );
    assert.deepEqual(received[0], {
      requestId,
      subject: "Feedback",
      priority: "low",
      type: "General",
      message: "unchanged",
    });
  });
});
