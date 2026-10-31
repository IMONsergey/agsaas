import type {
  ImportAmountFormat,
  ImportAmountParseResult,
  ImportDateOrder,
  ImportParseResult,
} from "./parse-profile";

const months: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function calendarDate(year: number, month: number, day: number) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0)
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Validate the entire timestamp, while retaining the calendar date at source. */
function validTimeSuffix(suffix: string): boolean {
  if (suffix === "") return true;
  const match = suffix.match(
    /^(?:[Tt]| +)(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:(?: ?[Zz])|(?: +(UTC|GMT))|(?: ?([+-])(\d{2}):?(\d{2})))?$/,
  );
  if (!match) return false;
  return (
    Number(match[1]) <= 23 &&
    Number(match[2]) <= 59 &&
    Number(match[3] ?? 0) <= 59 &&
    Number(match[6] ?? 0) <= 23 &&
    Number(match[7] ?? 0) <= 59
  );
}

/** No natural-language guesses, partial matches, reference date, or local TZ. */
export function parseDateValue(
  input: string,
  dateOrder: ImportDateOrder = "auto",
): ImportParseResult<string> {
  const value = input?.trim();
  if (!value) return { error: "missing" };

  const yearFirst = value.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(.*)$/);
  if (yearFirst) {
    const date = calendarDate(
      Number(yearFirst[1]),
      Number(yearFirst[3]),
      Number(yearFirst[4]),
    );
    return date && validTimeSuffix(yearFirst[5] ?? "")
      ? { value: date }
      : { error: "invalid" };
  }

  const numeric = value.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(.*)$/);
  if (numeric) {
    if (!validTimeSuffix(numeric[5] ?? "")) return { error: "invalid" };
    const first = Number(numeric[1]);
    const second = Number(numeric[3]);
    const year = Number(numeric[4]);
    const dayFirst = calendarDate(year, second, first);
    const monthFirst = calendarDate(year, first, second);
    if (dateOrder === "day-first") {
      return dayFirst ? { value: dayFirst } : { error: "invalid" };
    }
    if (dateOrder === "month-first") {
      return monthFirst ? { value: monthFirst } : { error: "invalid" };
    }
    if (dayFirst && monthFirst && dayFirst !== monthFirst) {
      return { error: "ambiguous" };
    }
    const date = dayFirst ?? monthFirst;
    return date ? { value: date } : { error: "invalid" };
  }

  // Preserve the existing, unambiguous English month-name exports. These are
  // exact supported forms, not a language model/natural-language date parser.
  const monthFirst = value.match(
    /^([A-Za-z]+)\.?[ /-]+(\d{1,2}),?[ /-]+(\d{4})(.*)$/,
  );
  const dayFirst = value.match(
    /^(\d{1,2})[ /-]+([A-Za-z]+)\.?[ /-]+(\d{4})(.*)$/,
  );
  const named = monthFirst ?? dayFirst;
  if (!named || !validTimeSuffix(named[4] ?? "")) return { error: "invalid" };
  const monthName = monthFirst ? named[1] : named[2];
  const day = Number(monthFirst ? named[2] : named[1]);
  const month = months[monthName?.toLowerCase() ?? ""];
  const date = month ? calendarDate(Number(named[3]), month, day) : undefined;
  return date ? { value: date } : { error: "invalid" };
}

/** The legacy return shape is preserved; ambiguity is never silently guessed. */
export function formatDate(
  dateString: string,
  dateOrder: ImportDateOrder = "auto",
): string | undefined {
  return parseDateValue(dateString, dateOrder).value;
}

/** Accept one consistent grouping separator with groups of exactly 3 digits. */
function integerDigits(value: string): string | undefined {
  if (/^\d+$/.test(value)) return value;
  if (/^\d{1,3}(?: \d{3})+$/.test(value)) return value.replaceAll(" ", "");
  if (/^\d{1,3}(?:,\d{3})+$/.test(value)) return value.replaceAll(",", "");
  if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) return value.replaceAll(".", "");
  return undefined;
}

function decimalDigits(
  value: string,
  separator: "." | ",",
): string | undefined {
  const parts = value.split(separator);
  if (parts.length !== 2) return undefined;
  const [whole, fraction] = parts;
  if (!fraction || !/^\d+$/.test(fraction)) return undefined;
  const integer = whole === "" ? "0" : integerDigits(whole ?? "");
  return integer === undefined ? undefined : `${integer}.${fraction}`;
}

export function parseAmountValue({
  amount,
  amountFormat = "auto",
  inverted = false,
}: {
  amount?: string | null;
  amountFormat?: ImportAmountFormat;
  inverted?: boolean;
}): ImportAmountParseResult {
  const trimmed = amount?.trim();
  if (!trimmed) return { error: "missing" };

  // NBSP and narrow NBSP are conventional group separators in RU exports.
  // Do not strip arbitrary whitespace: "12 34" must not silently become 1234.
  const normalized = trimmed.replace(/[\u00a0\u202f]/g, " ").replace(/^−/, "-");
  const sign = normalized.startsWith("-") ? -1 : 1;
  const unsigned = normalized.replace(/^[+-]/, "");
  if (!/^[\d., ]+$/.test(unsigned)) return { error: "invalid" };

  let digits: string | undefined;
  if (amountFormat !== "auto") {
    const decimal = amountFormat === "decimal-comma" ? "," : ".";
    digits = unsigned.includes(decimal)
      ? decimalDigits(unsigned, decimal)
      : integerDigits(unsigned);
  } else if (unsigned.includes(".") && unsigned.includes(",")) {
    const decimal =
      unsigned.lastIndexOf(".") > unsigned.lastIndexOf(",") ? "." : ",";
    digits = decimalDigits(unsigned, decimal);
  } else {
    const separator = unsigned.includes(",") ? "," : ".";
    const integer = integerDigits(unsigned);
    const decimal = unsigned.includes(separator)
      ? decimalDigits(unsigned, separator)
      : undefined;
    if (integer !== undefined && decimal !== undefined) {
      // 1,234 / 1.234 can mean either 1234 or 1.234. A profile is required.
      return { error: "ambiguous" };
    }
    digits = decimal ?? integer;
  }

  if (digits === undefined) return { error: "invalid" };
  const value = Number(digits) * sign * (inverted ? -1 : 1);
  if (
    !Number.isFinite(value) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER ||
    (value === 0 && /[1-9]/.test(digits))
  ) {
    return { error: "invalid" };
  }
  return { value, normalizedDecimal: digits };
}

export function formatAmountValue(options: {
  amount?: string | null;
  inverted?: boolean;
  amountFormat?: ImportAmountFormat;
}): number {
  return parseAmountValue(options).value ?? Number.NaN;
}
