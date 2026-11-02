import { describe, expect, it } from "bun:test";
import { createTransactionTransformer, transform } from "./transform";
import { validateTransactions } from "./validate";

const baseTransaction = {
  teamId: "team-1",
  bankAccountId: "bank-1",
  date: "2026-02-25",
  amount: "100.50",
  currency: "sek",
  description: "Coffee Shop",
  counterparty: "Acme AB",
};

describe("transform internal_id", () => {
  it("generates deterministic internal_id for identical input", () => {
    const first = transform({
      transaction: baseTransaction,
      inverted: false,
    });
    const second = transform({
      transaction: baseTransaction,
      inverted: false,
    });

    expect(first.internal_id).toBe(second.internal_id);
    // Frozen v1 ID: upgrading the parser must not duplicate correct legacy rows.
    expect(first.internal_id).toBe("team-1_9b3c6bc88a31404768efa9f7");
  });

  it("changes internal_id when transaction fingerprint changes", () => {
    const first = transform({
      transaction: baseTransaction,
      inverted: false,
    });
    const second = transform({
      transaction: {
        ...baseTransaction,
        amount: "101.50",
      },
      inverted: false,
    });

    expect(first.internal_id).not.toBe(second.internal_id);
  });
});

describe("whole-file occurrence identity", () => {
  it("preserves two legitimate identical rows and makes repeat imports idempotent", () => {
    const input = [baseTransaction, baseTransaction];
    const first = input.map(createTransactionTransformer({ inverted: false }));
    const repeat = input.map(createTransactionTransformer({ inverted: false }));
    expect(first.map((row) => row.internal_id)).toEqual([
      "team-1_9b3c6bc88a31404768efa9f7",
      "team-1_9b3c6bc88a31404768efa9f7_2",
    ]);
    expect(repeat).toEqual(first);
  });

  it("continues ordinals across chunks, without using absolute row positions", () => {
    const transformRow = createTransactionTransformer({ inverted: false });
    const firstChunk = [baseTransaction].map(transformRow);
    const different = { ...baseTransaction, description: "Another operation" };
    const secondChunk = [different, baseTransaction, baseTransaction].map(
      transformRow,
    );
    const reordered = [
      baseTransaction,
      different,
      baseTransaction,
      baseTransaction,
    ].map(createTransactionTransformer({ inverted: false }));
    expect(
      [...firstChunk, ...secondChunk].map((row) => row.internal_id).sort(),
    ).toEqual(reordered.map((row) => row.internal_id).sort());
    expect(secondChunk[2]?.internal_id).toBe(`${firstChunk[0]?.internal_id}_3`);
  });

  it("reconciles normalized values, not CSV punctuation or description spacing", () => {
    const transformRow = createTransactionTransformer({ inverted: false });
    const first = transformRow(baseTransaction);
    const next = transformRow({
      ...baseTransaction,
      date: "Feb 25, 2026",
      amount: "100,50",
      description: " coffee   SHOP ",
      counterparty: " acme ab ",
      currency: "SEK",
    });
    expect(next.internal_id).toBe(`${first.internal_id}_2`);
  });

  it("keeps team, account, date, amount, currency and counterparty identities separate", () => {
    const variants = [
      baseTransaction,
      { ...baseTransaction, teamId: "team-2" },
      { ...baseTransaction, bankAccountId: "bank-2" },
      { ...baseTransaction, date: "2026-02-26" },
      { ...baseTransaction, amount: "100.51" },
      { ...baseTransaction, currency: "rub" },
      { ...baseTransaction, counterparty: "Another party" },
    ].map(createTransactionTransformer({ inverted: false }));
    expect(new Set(variants.map((row) => row.internal_id)).size).toBe(
      variants.length,
    );
  });

  it("propagates profiles to date, amount, category and identity", () => {
    const value = transform({
      transaction: {
        ...baseTransaction,
        date: "04.09.2024",
        amount: "1\u00a0234,56",
      },
      inverted: true,
      parseProfile: { dateOrder: "day-first", amountFormat: "decimal-comma" },
    });
    expect(value.date).toBe("2024-09-04");
    expect(value.amount).toBe(-1234.56);
    expect(value.category_slug).toBeNull();
    expect(validateTransactions([value]).validTransactions).toHaveLength(1);
    expect(value.internal_id).toBe(
      transform({
        transaction: {
          ...baseTransaction,
          date: "2024-09-04",
          amount: "-1234.56",
        },
        inverted: false,
      }).internal_id,
    );
  });

  it("does not turn ambiguous or invalid rows into valid financial records", () => {
    const input = [
      { ...baseTransaction, date: "01/02/2024" },
      { ...baseTransaction, amount: "1,234" },
      { ...baseTransaction, amount: "Infinity" },
      { ...baseTransaction, date: "tomorrow" },
    ].map(createTransactionTransformer({ inverted: false }));
    const result = validateTransactions(input);
    expect(result.validTransactions).toHaveLength(0);
    expect(result.invalidTransactions).toHaveLength(4);
    const valid = transform({ transaction: baseTransaction, inverted: false });
    expect(
      validateTransactions([{ ...valid, amount: Number.POSITIVE_INFINITY }])
        .invalidTransactions,
    ).toHaveLength(1);
  });
});
