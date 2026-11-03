import { beforeEach, describe, expect, test } from "bun:test";
import {
  InvoiceAmountError,
  InvoiceFinancialStateError,
} from "@midday/invoice/calculate";
// Import after mocking (mocks are set up via preload)
import { createCallerFactory } from "../../trpc/init";
import { invoiceRouter } from "../../trpc/routers/invoice";
import {
  createInvoicesListResponse,
  createMinimalInvoiceResponse,
  createPaidInvoiceResponse,
  createValidInvoiceResponse,
} from "../factories/invoice";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const INVOICE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// Create a test caller
const createCaller = createCallerFactory(invoiceRouter);

describe("tRPC: invoice.get", () => {
  beforeEach(() => {
    mocks.getInvoices.mockReset();
    mocks.getInvoices.mockImplementation(() => createInvoicesListResponse());
  });

  test("returns invoices list", async () => {
    mocks.getInvoices.mockImplementation(() =>
      createInvoicesListResponse([createValidInvoiceResponse()]),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data).toHaveLength(1);
    expect(result.meta.hasNextPage).toBe(false);
  });

  test("handles minimal invoice data", async () => {
    mocks.getInvoices.mockImplementation(() =>
      createInvoicesListResponse([createMinimalInvoiceResponse()]),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data[0]!.vat).toBeNull();
  });

  test("handles empty list", async () => {
    mocks.getInvoices.mockImplementation(() => createInvoicesListResponse([]));

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data).toEqual([]);
  });

  test("filters by status", async () => {
    mocks.getInvoices.mockImplementation(() => createInvoicesListResponse([]));

    const caller = createCaller(createTestContext());
    await caller.get({ statuses: ["paid"] });

    // Just verify the mock was called - the status filtering happens in the DB
    expect(mocks.getInvoices).toHaveBeenCalled();
  });

  test("handles paid invoices", async () => {
    mocks.getInvoices.mockImplementation(() =>
      createInvoicesListResponse([createPaidInvoiceResponse()]),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data[0]!.status).toBe("paid");
  });
});

describe("tRPC: invoice.getById", () => {
  beforeEach(() => {
    mocks.getInvoiceById.mockReset();
  });

  test("returns single invoice", async () => {
    mocks.getInvoiceById.mockImplementation(() => createValidInvoiceResponse());

    const caller = createCaller(createTestContext());
    const result = await caller.getById({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });

    expect(result?.id).toBe("a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
  });

  test("returns null for non-existent invoice", async () => {
    mocks.getInvoiceById.mockImplementation(() => null);

    const caller = createCaller(createTestContext());
    const result = await caller.getById({
      id: "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    });

    expect(result).toBeNull();
  });

  test("passes correct parameters to DB query", async () => {
    mocks.getInvoiceById.mockImplementation(() => createValidInvoiceResponse());

    const caller = createCaller(createTestContext());
    await caller.getById({ id: "c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f" });

    expect(mocks.getInvoiceById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f",
        teamId: "test-team-id",
      }),
    );
  });
});

describe("tRPC: invoice.delete", () => {
  beforeEach(() => {
    mocks.deleteInvoice.mockReset();
    mocks.deleteInvoice.mockImplementation(() => ({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    }));
  });

  test("deletes invoice successfully", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });

    expect(result).toBeDefined();
  });

  test("passes teamId to DB query", async () => {
    const caller = createCaller(createTestContext());
    await caller.delete({ id: "d4e5f6a7-8b9c-4d0e-1f2a-3b4c5d6e7f8a" });

    expect(mocks.deleteInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
      }),
    );
  });
});

describe("tRPC: invoice.invoiceSummary", () => {
  beforeEach(() => {
    mocks.getInvoiceSummary.mockReset();
    mocks.getInvoiceSummary.mockImplementation(() => ({
      totalAmount: 10000,
      invoiceCount: 5,
      currency: "USD",
    }));
  });

  test("returns invoice summary", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.invoiceSummary();

    expect(result.totalAmount).toBeDefined();
    expect(result.invoiceCount).toBeDefined();
    expect(result.currency).toBeDefined();
  });

  test("passes statuses to DB query", async () => {
    const caller = createCaller(createTestContext());
    await caller.invoiceSummary({ statuses: ["paid"] });

    expect(mocks.getInvoiceSummary).toHaveBeenCalled();
  });
});

describe("tRPC: invoice.searchInvoiceNumber", () => {
  beforeEach(() => {
    mocks.searchInvoiceNumber.mockReset();
    mocks.searchInvoiceNumber.mockImplementation(() => []);
  });

  test("searches for invoice numbers", async () => {
    mocks.searchInvoiceNumber.mockImplementation(() => [
      { invoiceNumber: "INV-001" },
      { invoiceNumber: "INV-002" },
    ]);

    const caller = createCaller(createTestContext());
    const result = await caller.searchInvoiceNumber({ query: "INV" });

    expect(result).toHaveLength(2);
  });

  test("returns empty array for no matches", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.searchInvoiceNumber({ query: "NONEXISTENT" });

    expect(result).toHaveLength(0);
  });
});

describe("tRPC: invoice.update", () => {
  beforeEach(() => {
    mocks.updateInvoiceWithIntent.mockReset();
    mocks.updateInvoice.mockClear();
    mocks.triggerJob.mockClear();
    mocks.updateInvoiceWithIntent.mockImplementation(() => ({
      id: INVOICE_ID,
      status: "paid",
    }));
  });

  test("updates invoice through the atomic public command", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.update({
      id: INVOICE_ID,
      status: "paid",
    });

    expect(result).toMatchObject({ id: INVOICE_ID, status: "paid" });
    expect(mocks.updateInvoiceWithIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: INVOICE_ID,
        teamId: "test-team-id",
        userId: "test-user-id",
        status: "paid",
      }),
    );
  });
  test("generic unpaid status returns its durable receipt without primitive or Redis fallback", async () => {
    mocks.updateInvoiceWithIntent.mockImplementation(() => ({
      id: INVOICE_ID,
      status: "unpaid",
      operation: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "pending",
      },
    }));
    const result = await createCaller(createTestContext()).update({
      id: INVOICE_ID,
      status: "unpaid",
    });
    expect(result).toMatchObject({ operation: { status: "pending" } });
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("a failed generic schedule command cannot fall back to split writes", async () => {
    mocks.updateInvoiceWithIntent.mockImplementation(() => {
      throw new Error("atomic fixture failure");
    });
    await expect(
      createCaller(createTestContext()).update({
        id: INVOICE_ID,
        status: "scheduled",
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    ).rejects.toThrow("atomic fixture failure");
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});

describe("tRPC: invoice.draft", () => {
  beforeEach(() => {
    mocks.draftInvoice.mockReset();
    mocks.getNextInvoiceNumber.mockReset();
    mocks.getNextInvoiceNumber.mockImplementation(() => "INV-NEXT");
    mocks.draftInvoice.mockImplementation((_, args: { id: string }) => ({
      id: args.id,
      invoiceNumber: "INV-NEXT",
    }));
  });

  test("saves draft with line items and calls draftInvoice", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.draft({
      id: INVOICE_ID,
      dueDate: "2026-06-30T23:59:59.000Z",
      issueDate: "2026-06-01T00:00:00.000Z",
      template: {},
      lineItems: [{ name: "Consulting", quantity: 2, price: 150, vat: 0 }],
    });

    expect(result).toMatchObject({ id: INVOICE_ID });
    expect(mocks.draftInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: INVOICE_ID,
        teamId: "test-team-id",
        userId: "test-user-id",
        invoiceNumber: "INV-NEXT",
        lineItems: expect.arrayContaining([
          expect.objectContaining({
            name: "Consulting",
            quantity: 2,
            price: 150,
          }),
        ]),
      }),
    );
  });

  test("maps rejected server money to BAD_REQUEST instead of an internal error", async () => {
    mocks.draftInvoice.mockImplementation(() => {
      throw new InvoiceAmountError("amount exceeds storage limit");
    });
    const caller = createCaller(createTestContext());
    await expect(
      caller.draft({
        id: INVOICE_ID,
        template: {},
        dueDate: "2026-06-30",
        issueDate: "2026-06-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("maps payment-locked financial edits to CONFLICT", async () => {
    mocks.draftInvoice.mockImplementation(() => {
      throw new InvoiceFinancialStateError();
    });
    const caller = createCaller(createTestContext());
    await expect(
      caller.draft({
        id: INVOICE_ID,
        template: {},
        dueDate: "2026-06-30",
        issueDate: "2026-06-01",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("tRPC: invoice.createFromTracker currency", () => {
  beforeEach(() => {
    mocks.allocateTrackerEntriesToInvoice.mockReset();
    mocks.getUnbilledTrackerEntriesForInvoice.mockReset();
    mocks.getUnbilledTrackerEntriesForInvoice.mockImplementation(async () =>
      Object.values((await mocks.getTrackerRecordsByRange()).result).flat(),
    );
    mocks.draftInvoice.mockReset();
    mocks.draftInvoice.mockImplementation(() => ({ id: INVOICE_ID }));
    mocks.getTrackerProjectById.mockReset();
    mocks.getTrackerProjectById.mockImplementation(() => ({
      id: INVOICE_ID,
      name: "Work",
      billable: true,
      rate: 100,
      currency: "rub",
      customerId: null,
    }));
    mocks.getTrackerRecordsByRange.mockReset();
    mocks.getTrackerRecordsByRange.mockImplementation(() => ({
      result: { "2026-06-01": [{ id: INVOICE_ID, duration: 7200 }] },
    }));
    mocks.getInvoiceTemplate.mockReset();
    mocks.getInvoiceTemplate.mockImplementation(() => ({
      currency: "EUR",
      dateFormat: "dd/MM/yyyy",
    }));
    mocks.getTeamById.mockReset();
    mocks.getTeamById.mockImplementation(() => ({ baseCurrency: "USD" }));
    mocks.getUserById.mockReset();
    mocks.getUserById.mockImplementation(() => null);
    mocks.getNextInvoiceNumber.mockReset();
    mocks.getNextInvoiceNumber.mockImplementation(() => "INV-TRACKER");
  });

  test("keeps project currency after merging a conflicting saved invoice template", async () => {
    const caller = createCaller(createTestContext());
    await caller.createFromTracker({
      projectId: INVOICE_ID,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    expect(mocks.draftInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        template: expect.objectContaining({ currency: "RUB" }),
        lineItems: expect.arrayContaining([
          expect.objectContaining({ quantity: 2, price: 100 }),
        ]),
      }),
    );
    expect(mocks.allocateTrackerEntriesToInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
        entryIds: [INVOICE_ID],
      }),
    );
  });

  test("falls back to team currency, not template currency, when the project has none", async () => {
    mocks.getTrackerProjectById.mockImplementation(() => ({
      id: INVOICE_ID,
      name: "Work",
      billable: true,
      rate: 100,
      currency: null,
      customerId: null,
    }));
    const caller = createCaller(createTestContext());
    await caller.createFromTracker({
      projectId: INVOICE_ID,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    expect(mocks.draftInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        template: expect.objectContaining({ currency: "USD" }),
      }),
    );
  });
  test("historical rate and currency snapshots win over changed project terms", async () => {
    mocks.getTrackerProjectById.mockImplementation(() => ({
      id: INVOICE_ID,
      name: "Work",
      billable: true,
      rate: 999,
      currency: "EUR",
      customerId: null,
    }));
    mocks.getTrackerRecordsByRange.mockImplementation(() => ({
      result: {
        "2026-06-01": [
          { duration: 7200, rate: 100, currency: "USD" },
          { duration: 3600, rate: 150, currency: "USD" },
        ],
      },
    }));
    await createCaller(createTestContext()).createFromTracker({
      projectId: INVOICE_ID,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    expect(mocks.draftInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currency: "USD",
        amount: 350,
        lineItems: expect.arrayContaining([
          expect.objectContaining({ quantity: 2, price: 100 }),
          expect.objectContaining({ quantity: 1, price: 150 }),
        ]),
      }),
    );
  });

  test("mixed historical currencies require separate invoices instead of relabeling amounts", async () => {
    mocks.getTrackerRecordsByRange.mockImplementation(() => ({
      result: {
        "2026-06-01": [
          { duration: 3600, rate: 100, currency: "USD" },
          { duration: 3600, rate: 100, currency: "EUR" },
        ],
      },
    }));
    await expect(
      createCaller(createTestContext()).createFromTracker({
        projectId: INVOICE_ID,
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.draftInvoice).not.toHaveBeenCalled();
    expect(mocks.getNextInvoiceNumber).not.toHaveBeenCalled();
  });
});

describe("tRPC: invoice.remind acceptance semantics", () => {
  beforeEach(() => {
    mocks.getInvoiceById.mockReset();
    mocks.getInvoiceById.mockImplementation(() => ({
      id: INVOICE_ID,
      status: "unpaid",
      reminderSentAt: null,
    }));
    mocks.updateInvoice.mockReset();
    mocks.triggerJob.mockReset();
    mocks.triggerJob.mockImplementation(() => ({ id: "reminder-job" }));
  });

  test("queues only a team-scoped payable invoice without recording a client-supplied timestamp", async () => {
    const caller = createCaller(createTestContext());
    expect(
      await caller.remind({ id: INVOICE_ID, date: "2099-01-01" }),
    ).toMatchObject({ reminderSentAt: null });
    expect(mocks.getInvoiceById).toHaveBeenCalledWith(expect.anything(), {
      id: INVOICE_ID,
      teamId: "test-team-id",
    });
    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "send-invoice-reminder",
      { invoiceId: INVOICE_ID },
      "invoices",
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });

  test("does not enqueue missing/foreign or already paid invoices", async () => {
    const caller = createCaller(createTestContext());
    mocks.getInvoiceById.mockImplementation(() => null);
    await expect(caller.remind({ id: INVOICE_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    mocks.getInvoiceById.mockImplementation(() => ({ status: "paid" }));
    await expect(caller.remind({ id: INVOICE_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("queue failure leaves the last accepted reminder timestamp untouched", async () => {
    mocks.getInvoiceById.mockImplementation(() => ({
      id: INVOICE_ID,
      status: "overdue",
      reminderSentAt: "2026-01-01",
    }));
    mocks.triggerJob.mockImplementation(() => {
      throw new Error("queue unavailable");
    });
    const caller = createCaller(createTestContext());
    await expect(caller.remind({ id: INVOICE_ID })).rejects.toThrow(
      "queue unavailable",
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });
});

describe("tRPC: invoice.create", () => {
  beforeEach(() => {
    mocks.issueInvoice.mockReset();
    mocks.scheduleInvoice.mockReset();
    mocks.updateInvoice.mockReset();
    mocks.triggerJob.mockReset();
    mocks.issueInvoice.mockImplementation(() => ({
      id: INVOICE_ID,
      invoiceNumber: "INV-100",
      operation: { id: "intent-1", status: "pending" },
    }));
  });
  test("returns the durable operation without direct Redis or split status writes", async () => {
    const result = await createCaller(createTestContext()).create({
      id: INVOICE_ID,
      deliveryType: "create",
    });
    expect(result?.operation).toEqual({ id: "intent-1", status: "pending" });
    expect(mocks.issueInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: INVOICE_ID,
        deliveryType: "create",
        teamId: "test-team-id",
        userId: "test-user-id",
      }),
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("a failed SQL command never falls back to a Redis-only send", async () => {
    mocks.issueInvoice.mockImplementation(() => {
      throw new Error("SQL fixture failure");
    });
    await expect(
      createCaller(createTestContext()).create({
        id: INVOICE_ID,
        deliveryType: "create_and_send",
      }),
    ).rejects.toThrow("SQL fixture failure");
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("a scheduled request persists its schedule through the shared command", async () => {
    const scheduledAt = new Date(Date.now() + 3600000).toISOString();
    mocks.scheduleInvoice.mockImplementation(() => ({
      id: INVOICE_ID,
      status: "scheduled",
    }));
    await createCaller(createTestContext()).create({
      id: INVOICE_ID,
      deliveryType: "scheduled",
      scheduledAt,
    });
    expect(mocks.scheduleInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: INVOICE_ID,
        scheduledAt,
        teamId: "test-team-id",
      }),
    );
    expect(mocks.triggerJob).not.toHaveBeenCalled();
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });
});

describe("tRPC: invoice.duplicate", () => {
  beforeEach(() => {
    mocks.getNextInvoiceNumber.mockReset();
    mocks.duplicateInvoice.mockReset();
    mocks.getNextInvoiceNumber.mockImplementation(() => "INV-DUP");
    mocks.duplicateInvoice.mockImplementation(() => ({
      id: "e1e2e3e4-e5e6-7890-abcd-ef1234567890",
      invoiceNumber: "INV-DUP",
    }));
  });

  test("duplicates invoice with next number", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.duplicate({ id: INVOICE_ID });

    expect(result).toMatchObject({
      id: "e1e2e3e4-e5e6-7890-abcd-ef1234567890",
      invoiceNumber: "INV-DUP",
    });
    expect(mocks.getNextInvoiceNumber).toHaveBeenCalled();
    expect(mocks.duplicateInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: INVOICE_ID,
        teamId: "test-team-id",
        userId: "test-user-id",
        invoiceNumber: "INV-DUP",
      }),
    );
  });
});

describe("tRPC: invoice.defaultSettings", () => {
  beforeEach(() => {
    mocks.getNextInvoiceNumber.mockReset();
    mocks.getInvoiceTemplate.mockReset();
    mocks.getTeamById.mockReset();
    mocks.getUserById.mockReset();
    mocks.getNextInvoiceNumber.mockImplementation(() => "INV-DEFAULT");
    mocks.getInvoiceTemplate.mockImplementation(() => ({
      id: "tmpl-1",
      name: "Default",
      currency: "EUR",
      size: "a4",
    }));
    mocks.getTeamById.mockImplementation(() => ({
      id: "test-team-id",
      baseCurrency: "SEK",
    }));
    mocks.getUserById.mockImplementation(() => ({
      locale: "sv",
      dateFormat: "yyyy-MM-dd",
      timezone: "Europe/Stockholm",
    }));
  });

  test("returns invoice number, template block, and draft defaults", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.defaultSettings();

    expect(result.invoiceNumber).toBe("INV-DEFAULT");
    expect(result.template).toMatchObject({
      currency: "EUR",
      name: "Default",
    });
    expect(result.status).toBe("draft");
    expect(result.lineItems).toEqual([
      { name: "", quantity: 0, price: 0, vat: 0 },
    ]);
    expect(mocks.getNextInvoiceNumber).toHaveBeenCalled();
    expect(mocks.getInvoiceTemplate).toHaveBeenCalled();
    expect(mocks.getTeamById).toHaveBeenCalled();
    expect(mocks.getUserById).toHaveBeenCalled();
  });
});

describe("tRPC: invoice.paymentStatus", () => {
  beforeEach(() => {
    mocks.getPaymentStatus.mockReset();
    mocks.getPaymentStatus.mockImplementation(() => ({
      score: 85,
      paymentStatus: "good",
    }));
  });

  test("returns payment status for team (no input)", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.paymentStatus();

    expect(result).toEqual({ score: 85, paymentStatus: "good" });
    expect(mocks.getPaymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });
});

describe("tRPC: invoice.mostActiveClient", () => {
  beforeEach(() => {
    mocks.getMostActiveClient.mockReset();
    mocks.getMostActiveClient.mockImplementation(() => ({
      customerId: "cust-1",
      invoiceCount: 10,
    }));
  });

  test("returns most active client", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.mostActiveClient();

    expect(result).toMatchObject({ customerId: "cust-1", invoiceCount: 10 });
    expect(mocks.getMostActiveClient).toHaveBeenCalledWith(expect.anything(), {
      teamId: "test-team-id",
    });
  });
});

describe("tRPC: invoice.inactiveClientsCount", () => {
  beforeEach(() => {
    mocks.getInactiveClientsCount.mockReset();
    mocks.getInactiveClientsCount.mockImplementation(() => 4);
  });

  test("returns inactive client count", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.inactiveClientsCount()).toBe(4);
    expect(mocks.getInactiveClientsCount).toHaveBeenCalledWith(
      expect.anything(),
      { teamId: "test-team-id" },
    );
  });
});

describe("tRPC: invoice.averageDaysToPayment", () => {
  beforeEach(() => {
    mocks.getAverageDaysToPayment.mockReset();
    mocks.getAverageDaysToPayment.mockImplementation(() => 21);
  });

  test("returns average days to payment", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.averageDaysToPayment()).toBe(21);
    expect(mocks.getAverageDaysToPayment).toHaveBeenCalledWith(
      expect.anything(),
      { teamId: "test-team-id" },
    );
  });
});

describe("tRPC: invoice.averageInvoiceSize", () => {
  beforeEach(() => {
    mocks.getAverageInvoiceSize.mockReset();
    mocks.getAverageInvoiceSize.mockImplementation(() =>
      Promise.resolve([
        {
          currency: "USD",
          averageAmount: 2500,
          invoiceCount: 10,
        },
      ]),
    );
  });

  test("returns average invoice size", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.averageInvoiceSize()).toEqual([
      { currency: "USD", averageAmount: 2500, invoiceCount: 10 },
    ]);
    expect(mocks.getAverageInvoiceSize).toHaveBeenCalledWith(
      expect.anything(),
      { teamId: "test-team-id" },
    );
  });
});

describe("tRPC: invoice.topRevenueClient", () => {
  beforeEach(() => {
    mocks.getTopRevenueClient.mockReset();
    mocks.getTopRevenueClient.mockImplementation(() => ({
      customerId: "cust-top",
      amount: 50000,
    }));
  });

  test("returns top revenue client", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.topRevenueClient();

    expect(result).toMatchObject({ customerId: "cust-top", amount: 50000 });
    expect(mocks.getTopRevenueClient).toHaveBeenCalledWith(expect.anything(), {
      teamId: "test-team-id",
    });
  });
});

describe("tRPC: invoice.newCustomersCount", () => {
  beforeEach(() => {
    mocks.getNewCustomersCount.mockReset();
    mocks.getNewCustomersCount.mockImplementation(() => 7);
  });

  test("returns new customers count", async () => {
    const caller = createCaller(createTestContext());
    expect(await caller.newCustomersCount()).toBe(7);
    expect(mocks.getNewCustomersCount).toHaveBeenCalledWith(expect.anything(), {
      teamId: "test-team-id",
    });
  });
});

describe("tRPC: public invoice publication boundary", () => {
  beforeEach(() => {
    mocks.getPublishedInvoiceById.mockReset();
    mocks.getInvoiceById.mockReset();
  });

  test("never falls back to the internal invoice query for a valid draft token", async () => {
    mocks.getPublishedInvoiceById.mockImplementation(() => null);
    for (const session of [null, createTestContext().session]) {
      const caller = createCaller({ ...createTestContext(), session });
      await expect(
        caller.getInvoiceByToken({ token: "fixture-valid-token" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(mocks.getInvoiceById).not.toHaveBeenCalled();
  });

  test("public token access uses the publication-filtered reader", async () => {
    mocks.getPublishedInvoiceById.mockImplementation(() =>
      createValidInvoiceResponse(),
    );
    const caller = createCaller({ ...createTestContext(), session: null });
    expect(
      await caller.getInvoiceByToken({ token: "fixture-valid-token" }),
    ).toBeDefined();
    expect(mocks.getPublishedInvoiceById).toHaveBeenCalledWith(
      expect.anything(),
      { id: "invoice-123" },
    );
    expect(mocks.getInvoiceById).not.toHaveBeenCalled();
  });
});
