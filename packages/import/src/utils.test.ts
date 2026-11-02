import { describe, expect, it } from "bun:test";
import {
  formatAmountValue,
  formatDate,
  parseAmountValue,
  parseDateValue,
} from "./utils";

describe("formatAmountValue", () => {
  it("should handle numbers with comma as decimal separator", () => {
    expect(formatAmountValue({ amount: "1.234,56" })).toBe(1234.56);
  });

  it("rejects using the same separator for both grouping and decimals", () => {
    expect(formatAmountValue({ amount: "1.234.56" })).toBeNaN();
  });

  it("should handle numbers with period as decimal separator", () => {
    expect(formatAmountValue({ amount: "1234.56" })).toBe(1234.56);
  });

  it("should handle plain numbers", () => {
    expect(formatAmountValue({ amount: "1234" })).toBe(1234);
  });

  it("should invert the amount when inverted is true", () => {
    expect(formatAmountValue({ amount: "1234.56", inverted: true })).toBe(
      -1234.56,
    );
  });

  it("should handle negative numbers", () => {
    expect(formatAmountValue({ amount: "-1234.56" })).toBe(-1234.56);
  });

  it("should invert negative numbers when inverted is true", () => {
    expect(formatAmountValue({ amount: "-1234.56", inverted: true })).toBe(
      1234.56,
    );
  });

  it("should handle zero", () => {
    expect(formatAmountValue({ amount: "0" })).toBe(0);
    expect(formatAmountValue({ amount: "0", inverted: true })).toBe(-0);
  });

  it("should return NaN for undefined or empty amount", () => {
    expect(formatAmountValue({ amount: undefined })).toBe(NaN);
    expect(formatAmountValue({ amount: null })).toBe(NaN);
    expect(formatAmountValue({ amount: "" })).toBe(NaN);
    expect(formatAmountValue({ amount: "   " })).toBe(NaN);
  });
});

describe("formatDate", () => {
  it("should format a valid date string", () => {
    expect(formatDate("2023-05-15")).toBe("2023-05-15");
  });

  it("should handle date strings with non-date characters", () => {
    expect(formatDate("2023/05/15")).toBe("2023-05-15");
    expect(formatDate("May 15, 2023")).toBe("2023-05-15");
  });

  it("should return undefined for invalid date strings", () => {
    expect(formatDate("invalid-date")).toBeUndefined();
    expect(formatDate("2023-13-45")).toBeUndefined();
  });

  it("should reject invalid days for month (Feb 30, Apr 31)", () => {
    expect(formatDate("2023-02-30")).toBeUndefined();
    expect(formatDate("2023-04-31")).toBeUndefined();
    expect(formatDate("2023-06-31")).toBeUndefined();
    expect(formatDate("2023-09-31")).toBeUndefined();
    expect(formatDate("2023-11-31")).toBeUndefined();
  });

  it("should handle leap year dates correctly", () => {
    // 2024 is a leap year - Feb 29 is valid
    expect(formatDate("2024-02-29")).toBe("2024-02-29");
    // 2023 is not a leap year - Feb 29 is invalid
    expect(formatDate("2023-02-29")).toBeUndefined();
    // 2000 is a leap year (divisible by 400)
    expect(formatDate("2000-02-29")).toBe("2000-02-29");
    // 1900 was not a leap year (divisible by 100 but not 400)
    expect(formatDate("1900-02-29")).toBeUndefined();
  });

  it("should accept valid edge-of-month dates", () => {
    expect(formatDate("2023-01-31")).toBe("2023-01-31");
    expect(formatDate("2023-03-31")).toBe("2023-03-31");
    expect(formatDate("2023-04-30")).toBe("2023-04-30");
    expect(formatDate("2023-02-28")).toBe("2023-02-28");
  });

  it("should handle different date formats", () => {
    expect(formatDate("05/15/2023")).toBe("2023-05-15");
  });

  it("should handle dates with time", () => {
    expect(formatDate("2023-05-15T14:30:00")).toBe("2023-05-15");
  });

  it("should handle dates dot separated", () => {
    expect(formatDate("04.09.2024")).toBeUndefined();
    expect(formatDate("04.09.2024", "day-first")).toBe("2024-09-04");
    expect(formatDate("04.09.2024", "month-first")).toBe("2024-04-09");
  });

  it("should handle dates with time (dot format)", () => {
    expect(formatDate("08.05.2024 09:12:07", "day-first")).toBe("2024-05-08");
  });

  it("should handle dates 07/Aug/2024", () => {
    expect(formatDate("07/Aug/2024")).toBe("2024-08-07");
  });

  it("should handle dates 24-08-2024", () => {
    expect(formatDate("24-08-2024")).toBe("2024-08-24");
  });

  it("should handle dates in dd-MM-yyyy format", () => {
    expect(formatDate("24-09-2024")).toBe("2024-09-24");
  });

  it("requires a four-digit year rather than guessing its century", () => {
    expect(formatDate("11/4/24")).toBeUndefined();
    expect(formatDate("11/4/24", "month-first")).toBeUndefined();
  });

  // Timezone suffix formats (e.g., from Shopify exports)
  it("should handle dates with UTC timezone suffix", () => {
    expect(formatDate("2025-10-01 00:00:00 UTC")).toBe("2025-10-01");
  });

  it("should handle dates with GMT timezone suffix", () => {
    expect(formatDate("2025-10-01 00:00:00 GMT")).toBe("2025-10-01");
  });

  it("should handle ISO dates with Z suffix", () => {
    expect(formatDate("2025-10-01T00:00:00Z")).toBe("2025-10-01");
  });

  it("should handle ISO dates with timezone offset", () => {
    expect(formatDate("2025-10-01T00:00:00+00:00")).toBe("2025-10-01");
  });

  it("should handle timezone offset without colon (+0000 format)", () => {
    expect(formatDate("2025-10-01T00:00:00+0000")).toBe("2025-10-01");
    expect(formatDate("2025-10-01T05:30:00+0530")).toBe("2025-10-01");
  });

  it("should handle negative timezone offsets", () => {
    expect(formatDate("2025-10-01T00:00:00-05:00")).toBe("2025-10-01");
    expect(formatDate("2025-10-01T00:00:00-0800")).toBe("2025-10-01");
  });

  it("should preserve date in source timezone (not shift to UTC)", () => {
    // Late-night dates with negative offsets would shift to next day if converted to UTC
    // e.g., 2025-10-01T23:00:00-05:00 is 2025-10-02T04:00:00Z in UTC
    // We should preserve the original date (2025-10-01), not the UTC date (2025-10-02)
    expect(formatDate("2025-10-01T23:00:00-05:00")).toBe("2025-10-01");
    expect(formatDate("2025-10-01T20:00:00-08:00")).toBe("2025-10-01");
    expect(formatDate("2025-10-01T22:00:00-03:00")).toBe("2025-10-01");
  });

  it("should handle space before timezone offset", () => {
    expect(formatDate("2025-10-01 00:00:00+00:00")).toBe("2025-10-01");
    expect(formatDate("2025-10-01 12:00:00-05:00")).toBe("2025-10-01");
  });

  it("should handle Shopify-style date with time and UTC", () => {
    expect(formatDate("2025-09-30 18:03:25 UTC")).toBe("2025-09-30");
  });

  // Exact, complete named dates remain supported without natural-language guesses.
  it("should handle complete English month-name dates", () => {
    expect(formatDate("October 1, 2025")).toBe("2025-10-01");
  });

  it("should handle abbreviated month dates", () => {
    expect(formatDate("Oct 1, 2025")).toBe("2025-10-01");
  });

  // Edge cases
  it("should handle empty strings", () => {
    expect(formatDate("")).toBeUndefined();
  });

  it("should handle whitespace-only strings", () => {
    expect(formatDate("   ")).toBeUndefined();
  });

  it("should handle strings with leading/trailing whitespace", () => {
    expect(formatDate("  2025-10-01  ")).toBe("2025-10-01");
  });
});

describe("strict amount profiles", () => {
  it.each([
    ["1,234.56", 1234.56],
    ["1.234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1\u00a0234,56", 1234.56],
    ["1\u202f234,56", 1234.56],
    ["−1\u00a0234,56", -1234.56],
    ["+1,234.56", 1234.56],
    ["1,234,567.89", 1234567.89],
    ["1.234.567,89", 1234567.89],
    ["1 234 567", 1234567],
    ["1,234,567", 1234567],
    ["1.234.567", 1234567],
    ["1234,567", 1234.567],
    [".50", 0.5],
    [",50", 0.5],
  ])("parses unambiguous amount %s", (amount, expected) => {
    expect(formatAmountValue({ amount })).toBe(expected);
    expect(formatAmountValue({ amount, inverted: true })).toBe(-expected);
  });

  it.each([
    "1,234",
    "1.234",
    "-12,345",
    "123.456",
    "0,123",
  ])("requires a profile for %s", (amount) => {
    expect(parseAmountValue({ amount })).toEqual({ error: "ambiguous" });
    expect(formatAmountValue({ amount })).toBeNaN();
  });

  it("applies the explicit decimal separator, including grouping-only values", () => {
    expect(
      formatAmountValue({ amount: "1,234", amountFormat: "decimal-dot" }),
    ).toBe(1234);
    expect(
      formatAmountValue({ amount: "1,234", amountFormat: "decimal-comma" }),
    ).toBe(1.234);
    expect(
      formatAmountValue({ amount: "1.234", amountFormat: "decimal-dot" }),
    ).toBe(1.234);
    expect(
      formatAmountValue({ amount: "1.234", amountFormat: "decimal-comma" }),
    ).toBe(1234);
    expect(
      formatAmountValue({
        amount: "1\u202f234,56",
        amountFormat: "decimal-comma",
      }),
    ).toBe(1234.56);
    expect(
      formatAmountValue({ amount: "1,234.56", amountFormat: "decimal-dot" }),
    ).toBe(1234.56);
    expect(
      formatAmountValue({ amount: "1,234.56", amountFormat: "decimal-comma" }),
    ).toBeNaN();
    expect(
      formatAmountValue({ amount: "1.234,56", amountFormat: "decimal-dot" }),
    ).toBeNaN();
  });

  it.each([
    "1.234.56",
    "1,23,456",
    "12 34",
    "1,234 567",
    "1  234",
    "1\t234",
    "1\n234",
    "1.",
    "1,",
    "1,,234",
    "--1",
    "1-",
    "1e3",
    "0x10",
    "Infinity",
    "NaN",
    "USD 1.00",
    "1.00 RUB",
    "(100)",
    "9007199254740992",
    "2025-01-01",
    ".",
    ",",
    "+",
    "-",
  ])("rejects malformed or unsupported amount %s", (amount) => {
    expect(parseAmountValue({ amount })).toEqual({ error: "invalid" });
  });

  it("distinguishes missing values and rejects overflow/underflow", () => {
    expect(parseAmountValue({ amount: "\u00a0" })).toEqual({
      error: "missing",
    });
    expect(formatAmountValue({ amount: "9".repeat(400) })).toBeNaN();
    expect(formatAmountValue({ amount: `0.${"0".repeat(400)}1` })).toBeNaN();
  });
});

describe("strict date profiles", () => {
  it.each([
    "01/02/2024",
    "01.02.2024",
    "01-02-2024",
  ])("requires a profile for %s", (value) => {
    expect(parseDateValue(value)).toEqual({ error: "ambiguous" });
    expect(formatDate(value, "day-first")).toBe("2024-02-01");
    expect(formatDate(value, "month-first")).toBe("2024-01-02");
  });

  it("does not infer a whole-file profile from another row", () => {
    expect(formatDate("15/01/2024")).toBe("2024-01-15");
    expect(formatDate("01/15/2024")).toBe("2024-01-15");
    expect(formatDate("01/02/2024")).toBeUndefined();
    expect(formatDate("12/12/2024")).toBe("2024-12-12");
    expect(formatDate("15/01/2024", "month-first")).toBeUndefined();
    expect(formatDate("01/15/2024", "day-first")).toBeUndefined();
  });

  it.each([
    "today",
    "tomorrow",
    "last Friday",
    "May 15",
    "05/15",
    "01/02/24",
    "01/02/202",
    "2024-01-01 trailing text",
    "prefix 2024-01-01",
    "2024-01-019",
    "2024-01/01",
    "2024-00-01",
    "2024-01-00",
    "0000-01-01",
    "31/04/2024",
    "29/02/2023",
    "February 30, 2024",
    "May 0, 2024",
    "NotAMonth 1, 2024",
    "2024-01-01T24:00:00",
    "2024-01-01T12:60:00",
    "2024-01-01T12:00:60",
    "2024-01-01T12:00:00+25:00",
    "2024-01-01T12:00:00+01:60",
    "2024-01-01T12:00:00Zjunk",
    "2024-01-01 UTC",
    "2024-01-01T12",
    "2024-01-01T12:00 EST",
  ])("rejects non-exact date %s", (value) => {
    expect(formatDate(value)).toBeUndefined();
  });

  it.each([
    ["29.02.2024", "2024-02-29"],
    ["2024/2/29", "2024-02-29"],
    ["2024.02.29", "2024-02-29"],
    ["1 September 2024", "2024-09-01"],
    ["Sept. 1, 2024", "2024-09-01"],
    ["0001-01-01", "0001-01-01"],
    ["0099-12-31", "0099-12-31"],
    ["2024-01-01T23:59:59.123456Z", "2024-01-01"],
    ["2024-01-01 23:59 +0530", "2024-01-01"],
  ])("preserves supported exact date %s", (value, expected) => {
    expect(formatDate(value)).toBe(expected);
  });
});
