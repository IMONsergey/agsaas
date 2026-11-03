import { expect, test } from "bun:test";
import { createInboxWebhookPostSchema } from "./schema";
import { getInboxDomain, getInboxEmail, getInboxIdFromEmail } from "./utils";

const env = {
  INBOX_DOMAIN: "receipts.example.test",
  NEXT_PUBLIC_INBOX_DOMAIN: "receipts.example.test",
};
test("own configured recipient round trips without upstream routing", () => {
  expect(getInboxEmail("egr34f", env)).toBe("egr34f@receipts.example.test");
  expect(getInboxIdFromEmail("egr34f@RECEIPTS.EXAMPLE.TEST", env)).toBe(
    "egr34f",
  );
});
test("missing, invalid, upstream and mismatched domains disable forwarding", () => {
  for (const value of [
    {},
    { INBOX_DOMAIN: "inbox.midday.ai" },
    { INBOX_DOMAIN: "bad/domain.test" },
    { INBOX_DOMAIN: "https://mail.example.test" },
    {
      INBOX_DOMAIN: "a.example.test",
      NEXT_PUBLIC_INBOX_DOMAIN: "b.example.test",
    },
  ]) {
    expect(getInboxDomain(value)).toBeNull();
    expect(getInboxEmail("egr34f", value)).toBeNull();
  }
});
test("recipient parser rejects foreign, malformed and path-like local parts", () => {
  for (const email of [
    "egr34f@inbox.midday.ai",
    "egr34f@other.example.test",
    "egr34f@receipts.example.test.attacker.test",
    "../egr34f@receipts.example.test",
    "egr34f+other@receipts.example.test",
    "egr34f@@receipts.example.test",
  ]) {
    expect(getInboxIdFromEmail(email, env)).toBeUndefined();
  }
  expect(getInboxEmail("", env)).toBeNull();
  expect(getInboxEmail("../tenant", env)).toBeNull();
});
test("webhook schema enforces the same configured boundary on every retry", () => {
  const schema = createInboxWebhookPostSchema(env);
  const body = {
    OriginalRecipient: "egr34f@receipts.example.test",
    FromFull: { Name: "Fixture", Email: "sender@example.test" },
    MessageID: "fixture-retry-1",
  };
  expect(schema.safeParse(body).success).toBe(true);
  expect(schema.safeParse(body).success).toBe(true);
  expect(
    schema.safeParse({ ...body, OriginalRecipient: "egr34f@inbox.midday.ai" })
      .success,
  ).toBe(false);
  expect(createInboxWebhookPostSchema({}).safeParse(body).success).toBe(false);
});
