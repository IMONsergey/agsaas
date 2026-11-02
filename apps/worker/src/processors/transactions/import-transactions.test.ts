import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type {
  UpsertTransactionData,
  UpsertTransactionsParams,
} from "@midday/db/queries";
import { transform } from "@midday/import/transform";
import type { Job } from "bullmq";
import Papa from "papaparse";
import type { ImportTransactionsPayload } from "../../schemas/transactions";

// Run this file in its own Bun process. Real Papa, mapping, profiles, occurrence
// IDs, validation, batch loop and processor are exercised. Only DB/file/queue
// boundaries are replaced; this is not a PostgreSQL or Storage security test.
const previousFetch = globalThis.fetch;
const previousConnect = Socket.prototype.connect;
let networkAttempts = 0;
const blockNetwork = (): never => {
  networkAttempts += 1;
  throw new Error("No network is allowed in import processor tests");
};
globalThis.fetch = Object.assign(async () => blockNetwork(), {
  preconnect: blockNetwork,
});
Socket.prototype.connect = blockNetwork;

let csv = "";
let writeCount = 0;
let failAtWrite: number | undefined;
const existingIds = new Map<string, string>();
const insertedRows: UpsertTransactionData[] = [];
const batchSizes: number[] = [];
const progress: Array<{ progress?: number; step?: string }> = [];
const followUps: Array<{ name: string; data: unknown; queue: string }> = [];

mock.module("@midday/db/queries", () => ({
  upsertTransactions: async (
    _db: unknown,
    params: UpsertTransactionsParams,
  ) => {
    writeCount += 1;
    batchSizes.push(params.transactions.length);
    if (writeCount === failAtWrite)
      throw new Error("fixture database rejection");
    const results: Array<{ id: string }> = [];
    for (const row of params.transactions) {
      if (existingIds.has(row.internalId)) continue;
      const id = randomUUID();
      existingIds.set(row.internalId, id);
      insertedRows.push(row);
      results.push({ id });
    }
    return results;
  },
}));
mock.module("@midday/db/worker-client", () => ({ getWorkerDb: () => ({}) }));
mock.module("@midday/job-client", () => ({
  triggerJob: async (name: string, data: unknown, queue: string) => {
    followUps.push({ name, data, queue });
    return { id: "fixture-job" };
  },
}));
mock.module("@midday/supabase/job", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([csv]), error: null }),
      }),
    },
  }),
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info() {},
    error() {},
    warn() {},
    debug() {},
  }),
}));

const { ImportTransactionsProcessor } = await import("./import-transactions");
const processor = new ImportTransactionsProcessor();
const baseRow = ["2026-02-25", "100.50", "Coffee Shop", "Acme AB"];
function makeCsv(rows: string[][], delimiter = ",") {
  return Papa.unparse(
    { fields: ["Date", "Amount", "Description", "Counterparty"], data: rows },
    { delimiter },
  );
}

function job(
  extra: Partial<ImportTransactionsPayload> = {},
): Job<ImportTransactionsPayload> {
  return {
    id: "fixture-import",
    name: "import-transactions",
    data: {
      teamId: "team-1",
      bankAccountId: "bank-1",
      currency: "sek",
      inverted: false,
      filePath: ["team-1", "imports", "fixture.csv"],
      mappings: {
        date: "Date",
        amount: "Amount",
        description: "Description",
        counterparty: "Counterparty",
      },
      ...extra,
    },
    opts: { removeOnComplete: false },
    attemptsMade: 0,
    updateProgress: async (value: { progress?: number; step?: string }) => {
      progress.push(value);
    },
  } as Job<ImportTransactionsPayload>;
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Import promise failed to settle")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  csv = makeCsv([baseRow]);
  writeCount = 0;
  failAtWrite = undefined;
  existingIds.clear();
  insertedRows.length = 0;
  batchSizes.length = 0;
  progress.length = 0;
  followUps.length = 0;
  networkAttempts = 0;
});
afterEach(() => expect(networkAttempts).toBe(0));
afterAll(() => {
  globalThis.fetch = previousFetch;
  Socket.prototype.connect = previousConnect;
});

describe("real CSV import processor with local boundary fakes", () => {
  test("imports one row without a trailing newline", async () => {
    const result = await bounded(processor.process(job()));
    expect(result).toEqual({
      importedCount: 1,
      skippedCount: 0,
      invalidCount: 0,
    });
    expect(insertedRows[0]).toMatchObject({
      amount: 100.5,
      date: "2026-02-25",
      currency: "SEK",
    });
    expect(followUps.map((next) => next.name)).toEqual([
      "enrich-transactions",
      "match-transactions-bidirectional",
    ]);
  });

  test("uses the chosen RU profile and preserves two identical operations", async () => {
    const row = ["04.09.2024", "1\u00a0234,56", "Оплата", "Поставщик"];
    csv = makeCsv([row, row], ";");
    const input = job({
      currency: "rub",
      parseProfile: { dateOrder: "day-first", amountFormat: "decimal-comma" },
    });
    expect(await bounded(processor.process(input))).toEqual({
      importedCount: 2,
      skippedCount: 0,
      invalidCount: 0,
    });
    expect(
      insertedRows.map((row) => [row.date, row.amount, row.currency]),
    ).toEqual([
      ["2024-09-04", 1234.56, "RUB"],
      ["2024-09-04", 1234.56, "RUB"],
    ]);
    expect(insertedRows[1]?.internalId).toBe(
      `${insertedRows[0]?.internalId}_2`,
    );
    expect(await bounded(processor.process(input))).toEqual({
      importedCount: 0,
      skippedCount: 2,
      invalidCount: 0,
    });
    expect(existingIds.size).toBe(2);
    expect(followUps).toHaveLength(2);
  });

  test("handles US grouping in auto mode and explicit month-first dates", async () => {
    csv = makeCsv([["04/09/2024", "-1,234.56", "Fixture", "Vendor"]]);
    await bounded(
      processor.process(
        job({ inverted: true, parseProfile: { dateOrder: "month-first" } }),
      ),
    );
    expect(insertedRows[0]).toMatchObject({
      date: "2024-04-09",
      amount: 1234.56,
      categorySlug: "income",
    });
  });

  test("skips ambiguous/invalid records with honest counts and never writes their values", async () => {
    csv = makeCsv([
      baseRow,
      ["01/02/2024", "10.00", "Ambiguous date", "Vendor"],
      ["2024-01-01", "1,234", "Ambiguous amount", "Vendor"],
      ["tomorrow", "1.00", "Relative date", "Vendor"],
      ["2024-01-01", "Infinity", "Invalid amount", "Vendor"],
    ]);
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 1,
      skippedCount: 0,
      invalidCount: 4,
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.name).toBe("Coffee Shop");
  });

  test("rejects numeric(10,2) precision/range before sending rows to persistence", async () => {
    csv = makeCsv(
      [
        "99999999.99",
        "-99999999.99",
        "100000000",
        "-100000000",
        "1.234",
        "1.00000000000000001",
      ].map((amount) => ["2024-01-01", amount, "Precision fixture", "Vendor"]),
    );
    const result = await bounded(
      processor.process(job({ parseProfile: { amountFormat: "decimal-dot" } })),
    );
    expect(result).toEqual({
      importedCount: 2,
      skippedCount: 0,
      invalidCount: 4,
    });
    expect(insertedRows.map((row) => row.amount)).toEqual([
      99999999.99, -99999999.99,
    ]);
  });

  test("does not enqueue enrichment when every input row is invalid", async () => {
    csv = makeCsv([["01/02/2024", "1,234", "Ambiguous", "Vendor"]]);
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 0,
      skippedCount: 0,
      invalidCount: 1,
    });
    expect(writeCount).toBe(0);
    expect(followUps).toHaveLength(0);
  });

  test("retains legacy first IDs while recovering the formerly collapsed second operation", async () => {
    const legacy = transform({
      transaction: {
        date: "2026-02-25",
        amount: "100.50",
        currency: "sek",
        teamId: "team-1",
        bankAccountId: "bank-1",
        description: "Coffee Shop",
        counterparty: "Acme AB",
      },
      inverted: false,
    });
    expect(legacy.internal_id).toBe("team-1_9b3c6bc88a31404768efa9f7");
    existingIds.set(legacy.internal_id, randomUUID());
    csv = makeCsv([baseRow, baseRow]);
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 1,
      skippedCount: 1,
      invalidCount: 0,
    });
    expect(insertedRows[0]?.internalId).toBe(`${legacy.internal_id}_2`);
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 0,
      skippedCount: 2,
      invalidCount: 0,
    });
  });

  test("ordinals survive real parser chunks and 500-row DB batches", async () => {
    const row = ["2024-01-01", "12.34", "X".repeat(80), "Vendor"];
    csv = makeCsv(Array.from({ length: 1501 }, () => row));
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 1501,
      skippedCount: 0,
      invalidCount: 0,
    });
    expect(
      progress.filter((value) => value.step === "transforming").length,
    ).toBeGreaterThan(1);
    expect(batchSizes).toContain(500);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(500);
    expect(existingIds.size).toBe(1501);
    expect(insertedRows.at(-1)?.internalId).toBe(
      `${insertedRows[0]?.internalId}_1501`,
    );
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 0,
      skippedCount: 1501,
      invalidCount: 0,
    });
    expect(followUps).toHaveLength(2);
  });

  test("a rejected DB batch settles the job; retry fills only the missing occurrences", async () => {
    csv = makeCsv(Array.from({ length: 601 }, () => baseRow));
    failAtWrite = 2;
    await expect(bounded(processor.process(job()))).rejects.toThrow(
      "fixture database rejection",
    );
    expect(existingIds.size).toBe(500);
    expect(followUps).toHaveLength(0);
    expect(progress.some((value) => value.step === "completed")).toBe(false);
    failAtWrite = undefined;
    expect(await bounded(processor.process(job()))).toEqual({
      importedCount: 101,
      skippedCount: 500,
      invalidCount: 0,
    });
    expect(existingIds.size).toBe(601);
  });

  test.each([
    'Date,Amount,Description\n2024-01-01,10,"unterminated',
    "Date,Amount,Description\n2024-01-01,10,Name,unexpected extra field",
  ])("malformed CSV rejects instead of hanging or writing shifted columns", async (content) => {
    csv = content;
    await expect(bounded(processor.process(job()))).rejects.toThrow(
      "malformed rows",
    );
    expect(writeCount).toBe(0);
    expect(followUps).toHaveLength(0);
  });

  test("a header-only CSV rejects instead of leaving a paused parser", async () => {
    csv = "Date,Amount,Description\n";
    await expect(bounded(processor.process(job()))).rejects.toThrow(
      "no transaction rows",
    );
    expect(writeCount).toBe(0);
    expect(followUps).toHaveLength(0);
  });
});
