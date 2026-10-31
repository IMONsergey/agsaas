import { describe, expect, it } from "bun:test";
import { type ImportCsvFormData, importSchema } from "./context";
import { buildImportRequest } from "./import-request";

const form: ImportCsvFormData = {
  file: new File(["Date,Amount\n2024-01-01,1.00"], "statement.csv"),
  currency: "RUB",
  bank_account_id: "00000000-0000-4000-8000-000000000001",
  amount: "Amount",
  date: "Date",
  description: "Description",
  balance: "Balance",
  inverted: false,
};

describe("actual import form request contract", () => {
  it("keeps omitted profiles backward compatible", () => {
    const data = importSchema.parse(form);
    expect(
      buildImportRequest(data, ["fixture", "statement.csv"]).parseProfile,
    ).toBeUndefined();
  });

  it("preserves the selected profile through form validation and request construction", () => {
    const data = importSchema.parse({
      ...form,
      parseProfile: { dateOrder: "day-first", amountFormat: "decimal-comma" },
    });
    expect(
      buildImportRequest(data, ["fixture", "statement.csv"]),
    ).toMatchObject({
      filePath: ["fixture", "statement.csv"],
      currency: "RUB",
      parseProfile: { dateOrder: "day-first", amountFormat: "decimal-comma" },
      mappings: { date: "Date", amount: "Amount", balance: "Balance" },
    });
  });

  it("never promotes sample rows or preview balances to currentBalance", () => {
    const sampled = {
      ...form,
      table: [{ Date: "2024-01-01", Balance: "-1 234,56" }],
      currentBalance: "999999.99",
      firstRows: [{ Date: "2024-01-02", Balance: "500" }],
    };
    const request = buildImportRequest(sampled);
    expect(request).not.toHaveProperty("currentBalance");
    expect(request).not.toHaveProperty("table");
    expect(request).not.toHaveProperty("firstRows");
    expect(request).not.toHaveProperty("file");
  });

  it("rejects unknown parsing profile options instead of dropping a typo", () => {
    expect(
      importSchema.safeParse({ ...form, parseProfile: { dateOrder: "ru" } })
        .success,
    ).toBe(false);
    expect(
      importSchema.safeParse({ ...form, parseProfile: { amountFormat: "USD" } })
        .success,
    ).toBe(false);
    expect(
      importSchema.safeParse({
        ...form,
        parseProfile: { dateFormat: "DD/MM/YYYY" },
      }).success,
    ).toBe(false);
  });
});
