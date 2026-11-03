import { beforeEach, describe, expect, test } from "bun:test";
import { invoicesRouter } from "../../rest/routers/invoices";
import { createTestApp } from "../helpers";
import { mocks } from "../setup";

// Type for response JSON
interface InvoiceListResponse {
  data: Array<{
    id: string;
    [key: string]: unknown;
  }>;
  meta: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    cursor: string | null;
  };
}

interface InvoiceResponse {
  id: string;
  [key: string]: unknown;
}

function createApp() {
  const app = createTestApp();
  app.route("/invoices", invoicesRouter);
  return app;
}

// Create a valid invoice response that matches the full schema
function createValidInvoiceForRest() {
  return {
    id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    status: "draft",
    dueDate: "2024-05-31T00:00:00.000Z",
    issueDate: "2024-05-01T00:00:00.000Z",
    invoiceNumber: "INV-001",
    amount: 1000,
    currency: "USD",
    customer: {
      id: "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      name: "Acme Corp",
      website: null,
      email: "billing@acme.com",
    },
    paidAt: null,
    reminderSentAt: null,
    note: null,
    vat: null,
    tax: null,
    discount: null,
    subtotal: 1000,
    viewedAt: null,
    customerName: "Acme Corp",
    sentTo: null,
    sentAt: null,
    createdAt: "2024-05-01T00:00:00.000Z",
    updatedAt: "2024-05-01T00:00:00.000Z",
    token: "test-token",
    lineItems: [{ id: "line-1", name: "Service", quantity: 1, price: 1000 }],
  };
}

describe("REST: GET /invoices", () => {
  const app = createApp();

  beforeEach(() => {
    mocks.getInvoices.mockReset();
  });

  test("returns 200 with valid invoice data", async () => {
    mocks.getInvoices.mockImplementation(() => ({
      data: [createValidInvoiceForRest()],
      meta: { cursor: null, hasNextPage: false, hasPreviousPage: false },
    }));

    const res = await app.request("/invoices");

    expect(res.status).toBe(200);
    const json = (await res.json()) as InvoiceListResponse;
    expect(json.data).toHaveLength(1);
    expect(json.meta.hasNextPage).toBe(false);
  });

  test("handles empty invoice list", async () => {
    mocks.getInvoices.mockImplementation(() => ({
      data: [],
      meta: { cursor: null, hasNextPage: false, hasPreviousPage: false },
    }));

    const res = await app.request("/invoices");

    expect(res.status).toBe(200);
    const json = (await res.json()) as InvoiceListResponse;
    expect(json.data).toEqual([]);
  });

  test("returns persisted totals and tax even when legacy line items would calculate differently", async () => {
    mocks.getInvoices.mockImplementation(() => ({
      data: [
        {
          ...createValidInvoiceForRest(),
          amount: 111,
          subtotal: 90,
          vat: 4,
          tax: 7,
          discount: 2,
          template: { includeLineItemTax: true },
          lineItems: [{ price: 1000, quantity: 1, taxRate: 20 }],
        },
      ],
      meta: { cursor: null, hasNextPage: false, hasPreviousPage: false },
    }));
    const res = await app.request("/invoices");
    expect(res.status).toBe(200);
    const json = (await res.json()) as InvoiceListResponse;
    expect(json.data[0]).toMatchObject({
      amount: 111,
      subtotal: 90,
      vat: 4,
      tax: 7,
    });
  });

  test("handles pagination metadata", async () => {
    mocks.getInvoices.mockImplementation(() => ({
      data: [createValidInvoiceForRest()],
      meta: {
        cursor: "next-cursor",
        hasNextPage: true,
        hasPreviousPage: false,
      },
    }));

    const res = await app.request("/invoices");

    expect(res.status).toBe(200);
    const json = (await res.json()) as InvoiceListResponse;
    expect(json.meta.hasNextPage).toBe(true);
    expect(json.meta.cursor).toBe("next-cursor");
  });

  test("calls DB query with team ID", async () => {
    mocks.getInvoices.mockImplementation(() => ({
      data: [],
      meta: { cursor: null, hasNextPage: false, hasPreviousPage: false },
    }));

    await app.request("/invoices?pageSize=10");

    expect(mocks.getInvoices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
        pageSize: 10,
      }),
    );
  });
});

describe("REST: GET /invoices/:id financial snapshot", () => {
  const app = createApp();

  beforeEach(() => {
    mocks.getInvoiceById.mockReset();
  });

  test("detail uses the same stored snapshot as list, PDF and payment", async () => {
    const invoice = {
      ...createValidInvoiceForRest(),
      amount: 111,
      subtotal: null,
      tax: 7,
      vat: 4,
      discount: 2,
      template: { includeLineItemTax: true, taxRate: 30 },
      lineItems: [{ price: 1000, quantity: 1, taxRate: 20 }],
    };
    mocks.getInvoiceById.mockImplementation(() => invoice);
    const res = await app.request(`/invoices/${invoice.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      amount: 111,
      subtotal: 102,
      tax: 7,
      vat: 4,
    });
  });

  test("amount-only invoices retain totals without needing synthetic line items", async () => {
    const invoice = {
      ...createValidInvoiceForRest(),
      lineItems: [],
      amount: 200,
      subtotal: null,
      tax: 10,
      vat: 0,
    };
    mocks.getInvoiceById.mockImplementation(() => invoice);
    const res = await app.request(`/invoices/${invoice.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      amount: 200,
      subtotal: 190,
      tax: 10,
    });
  });
});

describe("REST: DELETE /invoices/:id", () => {
  const app = createApp();

  beforeEach(() => {
    mocks.deleteInvoice.mockReset();
    mocks.deleteInvoice.mockImplementation(() => ({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    }));
  });

  test("deletes invoice successfully", async () => {
    const res = await app.request(
      "/invoices/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      {
        method: "DELETE",
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as InvoiceResponse;
    expect(json.id).toBe("a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
  });

  test("calls DB with correct parameters", async () => {
    await app.request("/invoices/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", {
      method: "DELETE",
    });

    expect(mocks.deleteInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        teamId: "test-team-id",
      }),
    );
  });
});

describe("REST: PUT /invoices/:id durable status changes", () => {
  const app = createApp();
  const id = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const operation = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "pending",
  };
  beforeEach(() => {
    mocks.updateInvoiceWithIntent.mockReset();
    mocks.updateInvoice.mockClear();
    mocks.triggerJob.mockClear();
    mocks.getInvoiceById.mockReset();
    mocks.getInvoiceById.mockImplementation(() => ({
      ...createValidInvoiceForRest(),
      status: "unpaid",
    }));
  });
  test("uses the atomic command and preserves its receipt", async () => {
    mocks.updateInvoiceWithIntent.mockImplementation(() => ({
      id,
      status: "unpaid",
      operation,
    }));
    const response = await app.request(`/invoices/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "unpaid" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      status: "unpaid",
      operation,
    });
    expect(mocks.updateInvoiceWithIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id, teamId: "test-team-id", status: "unpaid" }),
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("command failure never returns a successful unchanged detail or queues fallback work", async () => {
    mocks.updateInvoiceWithIntent.mockImplementation(() => {
      throw new Error("atomic fixture failure");
    });
    const response = await app.request(`/invoices/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "unpaid" }),
    });
    expect(response.status).toBe(500);
    expect(mocks.getInvoiceById).not.toHaveBeenCalled();
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});
