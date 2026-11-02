import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { formatAmountValue } from "../../../../../packages/import/src/utils";
import { buildImportRequest } from "../../../../dashboard/src/components/modals/import-modal/import-request";
import { importTransactionsSchema as workerSchema } from "../../../../worker/src/schemas/transactions";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

// The actual router, API schema, UI request builder, parser and worker schema
// execute. Database/queue boundaries use the existing API harness; no providers.
const { createCallerFactory } = await import("../../trpc/init");
const { transactionsRouter } = await import("../../trpc/routers/transactions");
const caller = createCallerFactory(transactionsRouter)(createTestContext());
const originalAmountParser = mocks.formatAmountValue.getMockImplementation();
const accountId = "00000000-0000-4000-8000-000000000001";

function request() {
  return buildImportRequest(
    {
      file: new File(["Date,Amount\n01/02/2024,1234"], "fixture.csv"),
      bank_account_id: accountId,
      currency: "RUB",
      date: "Date",
      amount: "Amount",
      description: "Description",
      balance: "Balance",
      inverted: false,
    },
    ["test-team-id", "imports", "fixture.csv"],
  );
}

beforeEach(() => {
  mocks.getBankAccountById.mockReset();
  mocks.getBankAccountById.mockImplementation(() => ({
    id: accountId,
    manual: true,
  }));
  mocks.updateBankAccount.mockReset();
  mocks.updateBankAccount.mockImplementation(() => ({}));
  mocks.triggerJob.mockReset();
  mocks.triggerJob.mockImplementation(() => ({ id: "fixture-job" }));
  mocks.formatAmountValue.mockReset();
  mocks.formatAmountValue.mockImplementation(formatAmountValue);
});

afterAll(() => {
  mocks.formatAmountValue.mockReset();
  if (originalAmountParser)
    mocks.formatAmountValue.mockImplementation(originalAmountParser);
});

describe("import UI → API → worker payload contract", () => {
  test("forwards a chosen profile unchanged and does not invent a sample balance", async () => {
    const input = {
      ...request(),
      parseProfile: {
        dateOrder: "day-first",
        amountFormat: "decimal-comma",
      } as const,
    };
    expect(await caller.import(input)).toEqual({ id: "fixture-job" });
    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "import-transactions",
      {
        filePath: input.filePath,
        bankAccountId: accountId,
        currency: "RUB",
        mappings: input.mappings,
        teamId: "test-team-id",
        inverted: false,
        parseProfile: input.parseProfile,
      },
      "transactions",
    );
    const payload = workerSchema.parse(mocks.triggerJob.mock.calls[0]?.[1]);
    expect(payload.parseProfile).toEqual(input.parseProfile);
    expect(mocks.updateBankAccount.mock.calls[0]?.[1]?.balance).toBeUndefined();
    expect(mocks.formatAmountValue).not.toHaveBeenCalled();
  });

  test("omitted profiles keep the old request shape accepted", async () => {
    await caller.import(request());
    expect(
      workerSchema.parse(mocks.triggerJob.mock.calls[0]?.[1]).parseProfile,
    ).toBeUndefined();
  });

  test("explicit manual-account balance stays supported, signed and profile aware", async () => {
    await caller.import({
      ...request(),
      inverted: true,
      currentBalance: "-1\u00a0234,56",
      parseProfile: { dateOrder: "day-first", amountFormat: "decimal-comma" },
    });
    expect(mocks.updateBankAccount).toHaveBeenCalledWith(expect.anything(), {
      id: accountId,
      teamId: "test-team-id",
      currency: "RUB",
      balance: -1234.56,
    });
    expect(mocks.formatAmountValue).toHaveBeenCalledWith({
      amount: "-1\u00a0234,56",
      amountFormat: "decimal-comma",
    });
  });

  test("a US explicit balance uses the same parser as transaction rows", async () => {
    await caller.import({ ...request(), currentBalance: "1,234.56" });
    expect(mocks.updateBankAccount.mock.calls[0]?.[1]?.balance).toBe(1234.56);
  });

  test.each([
    "1,234",
    "1.234",
    "Infinity",
    "12 34",
  ])("rejects unsafe explicit balance %s before mutation or enqueue", async (currentBalance) => {
    await expect(
      caller.import({ ...request(), currentBalance }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.updateBankAccount).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("keeps a connected account's bank-synced balance unchanged", async () => {
    mocks.getBankAccountById.mockImplementation(() => ({
      id: accountId,
      manual: false,
    }));
    await caller.import({ ...request(), currentBalance: "123.45" });
    expect(mocks.updateBankAccount).not.toHaveBeenCalled();
    expect(mocks.triggerJob).toHaveBeenCalledTimes(1);
  });

  test("unknown profile values fail at API and worker validation", async () => {
    const invalid = { ...request(), parseProfile: { amountFormat: "USD" } };
    // The transport boundary receives untyped JSON; schema validation is tested
    // directly rather than weakening the typed caller with an unsafe cast.
    const { importTransactionsSchema } = await import(
      "../../schemas/transactions"
    );
    expect(importTransactionsSchema.safeParse(invalid).success).toBe(false);
    expect(
      workerSchema.safeParse({ ...invalid, teamId: "test-team-id" }).success,
    ).toBe(false);
    expect(mocks.updateBankAccount).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("preserves the existing account ownership check before import", async () => {
    mocks.getBankAccountById.mockImplementation(() => null);
    await expect(caller.import(request())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mocks.updateBankAccount).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});
