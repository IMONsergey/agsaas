import { describe, expect, test } from "bun:test";
import {
  getProductEmailConfig,
  getProductEmailReviewRecipient,
  isProductEmailSender,
  isProductEmailTransportAvailable,
  ProductEmailReceiptError,
  requireProductEmailBatchReceipt,
  requireProductEmailReceipt,
  requireProductEmailTransport,
} from "./config";

const valid = {
  EMAIL_FROM: "Accounts <accounts@example.test>",
  EMAIL_REPLY_TO: "Help <support@example.test>",
  DASHBOARD_URL: "https://app.example.test/",
  APP_NAME: "Example",
};

describe("own product email identity and independent transport", () => {
  test("review recipient and incoming loop detection use only explicit own configuration", () => {
    expect(() => getProductEmailReviewRecipient(valid)).toThrow();
    expect(
      getProductEmailReviewRecipient({
        ...valid,
        EMAIL_REVIEW_TO: "review@example.test",
      }),
    ).toBe("review@example.test");
    expect(() =>
      getProductEmailReviewRecipient({
        ...valid,
        EMAIL_REVIEW_TO: "pontus@midday.ai",
      }),
    ).toThrow();
    expect(isProductEmailSender("ACCOUNTS@example.test", valid)).toBe(true);
    expect(isProductEmailSender("someone@example.test", valid)).toBe(false);
    expect(isProductEmailSender("inbox@midday.ai", {})).toBe(false);
  });
  test("direct SDK callers must receive a valid receipt and cannot count partial batches as success", () => {
    expect(
      requireProductEmailReceipt({ data: { id: "accepted-id" }, error: null }),
    ).toBe("accepted-id");
    for (const response of [
      undefined,
      { data: null },
      { data: { id: "" } },
      { error: { statusCode: 500 } },
    ]) {
      try {
        requireProductEmailReceipt(response);
        throw new Error("Expected missing receipt");
      } catch (error) {
        expect(error).toBeInstanceOf(ProductEmailReceiptError);
        expect((error as ProductEmailReceiptError).status).toBe("uncertain");
      }
    }
    for (const status of [400, 401, 429]) {
      try {
        requireProductEmailReceipt({ error: { statusCode: status } });
        throw new Error("Expected rejection");
      } catch (error) {
        expect((error as ProductEmailReceiptError).status).toBe("rejected");
      }
    }
    expect(
      requireProductEmailBatchReceipt(
        { data: { data: [{ id: "a" }, { id: "b" }] } },
        2,
      ),
    ).toEqual(["a", "b"]);
    expect(() =>
      requireProductEmailBatchReceipt({ data: { data: [{ id: "a" }] } }, 2),
    ).toThrow(ProductEmailReceiptError);
    expect(() =>
      requireProductEmailBatchReceipt(
        { data: { data: [{ id: "a" }, { id: "a" }] } },
        2,
      ),
    ).toThrow(ProductEmailReceiptError);
  });
  test("prepares own identity without starting a provider or requiring a key", () => {
    expect(getProductEmailConfig(valid)).toEqual({
      from: valid.EMAIL_FROM,
      replyTo: valid.EMAIL_REPLY_TO,
      appUrl: "https://app.example.test",
      productName: "Example",
    });
    expect(isProductEmailTransportAvailable(valid)).toBe(false);
    expect(() => requireProductEmailTransport(valid)).toThrow(
      "Product email is not configured",
    );
  });

  test("retains the invitation sender alias while preferring EMAIL_FROM", () => {
    expect(
      getProductEmailConfig({
        ...valid,
        EMAIL_FROM: "",
        TEAM_INVITATION_FROM: "Invites <invite@example.test>",
      }).from,
    ).toBe("Invites <invite@example.test>");
    expect(
      getProductEmailConfig({ ...valid, TEAM_INVITATION_FROM: "invalid" }).from,
    ).toBe(valid.EMAIL_FROM);
  });

  test("never invents an upstream sender or accepts injected headers/URL", () => {
    for (const patch of [
      { EMAIL_FROM: "" },
      { EMAIL_FROM: "Midday <middaybot@midday.ai>" },
      { EMAIL_FROM: "Sender <x@sub.midday.ai>" },
      { EMAIL_FROM: "sender@example.test\r\nBcc: other@example.test" },
      { EMAIL_REPLY_TO: "pontus@midday.ai" },
      { EMAIL_REPLY_TO: "sender@example.test\nInjected" },
      { APP_NAME: "Name\nInjected" },
      { DASHBOARD_URL: "https://app.midday.ai" },
      { DASHBOARD_URL: "https://user:password@app.example.test" },
      { DASHBOARD_URL: "https://app.example.test/settings" },
      { DASHBOARD_URL: "https://app.example.test?redirect=other" },
      { DASHBOARD_URL: "http://app.example.test" },
    ]) {
      expect(() => getProductEmailConfig({ ...valid, ...patch })).toThrow();
    }
  });

  test("transport checks are current, trim whitespace and do not validate frozen identity", () => {
    expect(requireProductEmailTransport({ RESEND_API_KEY: " fixture " })).toBe(
      "fixture",
    );
    expect(isProductEmailTransportAvailable({ RESEND_API_KEY: " " })).toBe(
      false,
    );
  });
});
