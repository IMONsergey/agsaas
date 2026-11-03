import { describe, expect, test } from "bun:test";
import {
  bankProviderConfigured,
  validateBankTransactions,
} from "./native-bank-payload";

const row = {
  id: "fixture-id",
  amount: 12,
  currency: "USD",
  date: "2026-11-03",
  status: "posted",
  balance: null,
  category: null,
  counterparty_name: null,
  merchant_name: null,
  method: "other",
  name: "Fixture",
  description: null,
};
describe("native bank input contract", () => {
  test("provider groups are independent and absent configuration is explicit", () => {
    expect(bankProviderConfigured("plaid", {})).toBe(false);
    expect(
      bankProviderConfigured("teller", {
        PLAID_CLIENT_ID: "fixture",
        PLAID_SECRET: "fixture",
      }),
    ).toBe(false);
    expect(
      bankProviderConfigured("plaid", {
        PLAID_CLIENT_ID: "fixture",
        PLAID_SECRET: "fixture",
      }),
    ).toBe(true);
  });
  test("duplicate identities and malformed financial values are rejected", () => {
    expect(() => validateBankTransactions([row, row])).toThrow();
    expect(() =>
      validateBankTransactions([{ ...row, amount: Number.NaN }]),
    ).toThrow();
    expect(() =>
      validateBankTransactions([{ ...row, amount: Number.POSITIVE_INFINITY }]),
    ).toThrow();
    expect(() =>
      validateBankTransactions([{ ...row, currency: "usd" }]),
    ).toThrow();
    expect(() =>
      validateBankTransactions([{ ...row, amount: 12.345 }]),
    ).toThrow();
  });
  test("pending status is preserved and only allowed fields reach SQL", () => {
    expect(
      validateBankTransactions([
        {
          ...row,
          status: "pending",
          teamId: "untrusted",
          accessToken: "fixture",
        },
      ]),
    ).toEqual([{ ...row, status: "pending" }]);
  });
  test("all rows must validate before any batch can reach the database", () => {
    expect(() =>
      validateBankTransactions([row, { id: "incomplete" }]),
    ).toThrow();
    expect(() =>
      validateBankTransactions(
        Array.from({ length: 10001 }, (_, i) => ({ ...row, id: String(i) })),
      ),
    ).toThrow();
  });
});
