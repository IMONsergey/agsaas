import { describe, expect, it } from "bun:test";
import {
  getBalanceFromLatestDate,
  isActiveRequest,
  parseBalancePreview,
  shouldApplyMappedColumn,
} from "./field-mapping.utils";

describe("isActiveRequest", () => {
  it("returns true when request id matches active request", () => {
    const activeRequestRef = { current: 2 };
    expect(isActiveRequest(2, activeRequestRef)).toBe(true);
  });

  it("returns false for stale request id", () => {
    const activeRequestRef = { current: 3 };
    expect(isActiveRequest(2, activeRequestRef)).toBe(false);
  });
});

describe("profile-aware, non-authoritative balance preview", () => {
  const sample = [
    { Date: "02/03/2024", Balance: "-1 234,56" },
    { Date: "03/02/2024", Balance: "200,00" },
  ];

  it("uses the chosen date order, not the server locale", () => {
    expect(getBalanceFromLatestDate(sample, "Date", "Balance")).toBeUndefined();
    expect(
      getBalanceFromLatestDate(sample, "Date", "Balance", {
        dateOrder: "day-first",
      }),
    ).toBe("-1 234,56");
    expect(
      getBalanceFromLatestDate(sample, "Date", "Balance", {
        dateOrder: "month-first",
      }),
    ).toBe("200,00");
  });

  it("preserves negative balances and applies the explicit amount profile", () => {
    expect(
      parseBalancePreview("-1\u00a0234,56", { amountFormat: "decimal-comma" }),
    ).toBe(-1234.56);
    expect(
      parseBalancePreview("-1,234.56", { amountFormat: "decimal-dot" }),
    ).toBe(-1234.56);
    expect(parseBalancePreview("1,234")).toBeNaN();
    expect(parseBalancePreview("1,234", { amountFormat: "decimal-dot" })).toBe(
      1234,
    );
  });

  it("does not produce a balance from missing mappings or invalid dates", () => {
    expect(getBalanceFromLatestDate([], "Date", "Balance")).toBeUndefined();
    expect(getBalanceFromLatestDate(sample, "Date", "None")).toBeUndefined();
    expect(
      getBalanceFromLatestDate(
        [{ Date: "tomorrow", Balance: "10" }],
        "Date",
        "Balance",
      ),
    ).toBeUndefined();
  });
});

describe("shouldApplyMappedColumn", () => {
  const fileColumns = ["Transaction Date", "Description", "Amount"];

  it("accepts valid mapped field and exact column name", () => {
    expect(
      shouldApplyMappedColumn("date", "Transaction Date", fileColumns),
    ).toBe(true);
  });

  it("rejects unknown field keys", () => {
    expect(
      shouldApplyMappedColumn("merchant", "Description", fileColumns),
    ).toBe(false);
  });

  it("rejects values that are not present columns", () => {
    expect(shouldApplyMappedColumn("amount", "Total", fileColumns)).toBe(false);
  });
});
