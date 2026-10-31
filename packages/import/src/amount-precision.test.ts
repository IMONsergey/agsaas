import { describe, expect, it } from "bun:test";
import { isValidTransactionAmount } from "./amount-precision";
import { transform } from "./transform";
import { formatAmountValue } from "./utils";
import { validateTransactions } from "./validate";

function validate(amount: string) {
  return validateTransactions([
    transform({
      transaction: {
        amount,
        date: "2024-01-01",
        currency: "rub",
        teamId: "team",
        bankAccountId: "account",
        description: "Fixture",
      },
      inverted: false,
      parseProfile: { amountFormat: "decimal-dot" },
    }),
  ]);
}

describe("existing numeric(10,2) import boundary", () => {
  it.each([
    "99999999.99",
    "-99999999.99",
    "0",
    "-0.00",
    "0.01",
    "1.2300",
    "99999999.9900",
  ])("accepts exactly representable value %s", (amount) => {
    const result = validate(amount);
    expect(result.validTransactions).toHaveLength(1);
    expect(result.validTransactions[0]?.amount).toBe(Number(amount));
  });

  it.each([
    "100000000",
    "-100000000",
    "99999999.991",
    "0.001",
    "-1.234",
    "1.00000000000000001",
    "99999999.99000000001",
  ])("rejects %s before insertion instead of rounding or overflowing", (amount) => {
    expect(validate(amount).invalidTransactions).toHaveLength(1);
  });

  it("does not impose transaction precision on the generic amount parser", () => {
    expect(
      formatAmountValue({ amount: "1,234", amountFormat: "decimal-comma" }),
    ).toBe(1.234);
    expect(formatAmountValue({ amount: "100000000" })).toBe(100000000);
  });

  it("also checks direct numeric validation without source digits", () => {
    expect(isValidTransactionAmount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidTransactionAmount(1.234)).toBe(false);
    expect(isValidTransactionAmount(100000000)).toBe(false);
    expect(isValidTransactionAmount(99_999_999.99)).toBe(true);
  });
});
