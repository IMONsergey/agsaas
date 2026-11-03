import { describe, expect, test } from "bun:test";
import {
  calculateInvoiceSettlement,
  exactMinor,
  type SettlementEntry,
} from "./invoice-settlement";
const payment = (id: string, amountMinor: string): SettlementEntry => ({
  id,
  kind: "payment",
  amountMinor,
  currency: "usd",
  paymentId: null,
  reversesId: null,
  occurredAt: "2026-01-01T12:00:00Z",
});
const refund = (
  id: string,
  paymentId: string,
  amountMinor: string,
): SettlementEntry => ({
  ...payment(id, amountMinor),
  kind: "refund",
  paymentId,
});
describe("independent exact settlement scenarios", () => {
  test("40 plus 60 dollars pays a 100 dollar invoice; partial refund reopens only 15 dollars", () => {
    const p1 = payment("p1", "4000"),
      p2 = payment("p2", "6000");
    expect(calculateInvoiceSettlement("10000", "usd", [p1])).toMatchObject({
      settledMinor: "4000",
      balanceMinor: "6000",
      status: "unpaid",
    });
    expect(calculateInvoiceSettlement("10000", "usd", [p2, p1])).toMatchObject({
      settledMinor: "10000",
      balanceMinor: "0",
      status: "paid",
    });
    expect(
      calculateInvoiceSettlement("10000", "usd", [
        p2,
        refund("r1", "p1", "1500"),
        p1,
      ]),
    ).toMatchObject({
      refundedMinor: "1500",
      netSettledMinor: "8500",
      balanceMinor: "1500",
      status: "unpaid",
    });
  });
  test("refund budget belongs to each payment, even when total invoice has enough funds", () => {
    expect(() =>
      calculateInvoiceSettlement("10000", "usd", [
        payment("p1", "4000"),
        payment("p2", "6000"),
        refund("r1", "p1", "4001"),
      ]),
    ).toThrow("remaining confirmed payment");
  });
  test("full refund and compensating refund reversal preserve the journal and exact balance", () => {
    const p = payment("p", "10000"),
      r = refund("r", "p", "10000");
    expect(calculateInvoiceSettlement("10000", "usd", [p, r])).toMatchObject({
      status: "refunded",
      balanceMinor: "10000",
      netSettledMinor: "0",
    });
    const reverse: SettlementEntry = {
      ...payment("reverse", "2500"),
      kind: "refund_reversal",
      paymentId: "p",
      reversesId: "r",
    };
    expect(
      calculateInvoiceSettlement("10000", "usd", [reverse, r, p]),
    ).toMatchObject({
      refundedMinor: "7500",
      netSettledMinor: "2500",
      balanceMinor: "7500",
    });
    expect(() =>
      calculateInvoiceSettlement("10000", "usd", [
        p,
        r,
        { ...reverse, amountMinor: "10001" },
      ]),
    ).toThrow("original refund");
  });
  test("overpayment is retained, not hidden or converted into an invented credit note", () => {
    expect(
      calculateInvoiceSettlement("10000", "usd", [payment("p", "11000")]),
    ).toMatchObject({
      balanceMinor: "0",
      overpaymentMinor: "1000",
      status: "paid",
    });
  });
  test("fractional, negative, unsafe, duplicate and cross-currency entries fail", () => {
    for (const value of ["0", "-1", "1.2", "1e2", "9007199254740992"])
      expect(() => exactMinor(value)).toThrow();
    const p = payment("p", "100");
    expect(() => calculateInvoiceSettlement("10000", "usd", [p, p])).toThrow(
      "Duplicate",
    );
    expect(() =>
      calculateInvoiceSettlement("10000", "usd", [{ ...p, currency: "eur" }]),
    ).toThrow("currency");
  });
});
