import { describe, expect, test } from "bun:test";
import { InvoicePaymentError } from "../errors";
import {
  canReplayInvoicePayment,
  getInvoicePaymentAmount,
  INVOICE_PAYMENT_REPLAY_WINDOW_MS,
} from "../queries/invoice-payments";

describe("payment amount and safe replay contracts", () => {
  test("converts storage decimals exactly without binary multiplication drift", () => {
    expect(getInvoicePaymentAmount(120.05, "USD")).toEqual({
      amountMinor: 12005,
      currency: "usd",
    });
    expect(getInvoicePaymentAmount(100, "JPY")).toEqual({
      amountMinor: 100,
      currency: "jpy",
    });
    expect(getInvoicePaymentAmount(1.23, "KWD")).toEqual({
      amountMinor: 1230,
      currency: "kwd",
    });
    expect(getInvoicePaymentAmount(999999.99, "EUR")).toEqual({
      amountMinor: 99999999,
      currency: "eur",
    });
    expect(getInvoicePaymentAmount(50000, "UGX")).toEqual({
      amountMinor: 5000000,
      currency: "ugx",
    });
    expect(getInvoicePaymentAmount(5, "ISK")).toEqual({
      amountMinor: 500,
      currency: "isk",
    });
  });
  for (const [amount, currency] of [
    [null, "usd"],
    [0, "usd"],
    [-1, "usd"],
    [Number.NaN, "usd"],
    [Number.POSITIVE_INFINITY, "usd"],
    [1.001, "usd"],
    [1.25, "jpy"],
    [1_000_000, "usd"],
    [99_999_999.99, "kwd"],
    [100, null],
    [100, ""],
    [100, "US"],
    [100.25, "isk"],
    [100.25, "ugx"],
  ] as const) {
    test(`rejects unsupported amount/currency ${amount}/${currency}`, () => {
      expect(() => getInvoicePaymentAmount(amount, currency)).toThrow(
        InvoicePaymentError,
      );
    });
  }
  test("bounds replay strictly before 23 hours, not the provider's 24-hour pruning boundary", () => {
    const createdAt = "2026-11-01T00:00:00.000Z";
    const reservation = { createdAt, lastAttemptAt: createdAt };
    expect(INVOICE_PAYMENT_REPLAY_WINDOW_MS).toBe(23 * 60 * 60 * 1000);
    expect(
      canReplayInvoicePayment(reservation, "2026-11-01T22:59:59.999Z"),
    ).toBe(true);
    expect(
      canReplayInvoicePayment(reservation, "2026-11-01T23:00:00.000Z"),
    ).toBe(false);
    expect(
      canReplayInvoicePayment(reservation, "2026-11-02T00:00:00.000Z"),
    ).toBe(false);
  });
  test("clock rollback, corrupt dates and impossible reservation order fail closed", () => {
    const createdAt = "2026-11-01T00:00:00.000Z";
    expect(
      canReplayInvoicePayment(
        { createdAt, lastAttemptAt: "2026-11-01T02:00:00.000Z" },
        "2026-11-01T01:59:59.999Z",
      ),
    ).toBe(false);
    expect(
      canReplayInvoicePayment(
        { createdAt, lastAttemptAt: "2026-10-31T23:59:59.999Z" },
        createdAt,
      ),
    ).toBe(false);
    expect(
      canReplayInvoicePayment(
        { createdAt: "bad", lastAttemptAt: createdAt },
        createdAt,
      ),
    ).toBe(false);
    expect(
      canReplayInvoicePayment({ createdAt, lastAttemptAt: createdAt }, "bad"),
    ).toBe(false);
  });
});
