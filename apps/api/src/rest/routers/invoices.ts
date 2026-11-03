import type { Context } from "@api/rest/types";
import {
  deleteInvoiceResponseSchema,
  deleteInvoiceSchema,
  draftInvoiceRequestSchema,
  draftInvoiceResponseSchema,
  getInvoiceByIdSchema,
  getInvoicesSchema,
  getPaymentStatusResponseSchema,
  invoiceResponseSchema,
  invoiceSummaryResponseSchema,
  invoiceSummarySchema,
  invoicesResponseSchema,
  updateInvoiceRequestSchema,
  updateInvoiceResponseSchema,
} from "@api/schemas/invoice";
import { validateResponse } from "@api/utils/validate-response";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  getCustomerById,
  issueInvoice as persistInvoiceIssue,
  scheduleInvoice as persistInvoiceSchedule,
  getInvoiceById,
  getInvoiceSummary,
  getInvoices,
  getInvoiceTemplate,
  getNextInvoiceNumber,
  getPaymentStatus,
  isInvoiceNumberUsed,
  deleteInvoice as persistInvoiceDelete,
  draftInvoice as persistInvoiceDraft,
  updateInvoiceWithIntent as persistInvoiceUpdate,
} from "@midday/db/queries";
import {
  getInvoiceSnapshotAmounts,
  InvoiceAmountError,
  InvoiceFinancialStateError,
} from "@midday/invoice/calculate";
import { transformCustomerToContent } from "@midday/invoice/utils";
import { addDays } from "date-fns";
import { HTTPException } from "hono/http-exception";
import { v4 as uuidv4 } from "uuid";
import { withRequiredScope } from "../middleware";

async function draftInvoice(...args: Parameters<typeof persistInvoiceDraft>) {
  try {
    return await persistInvoiceDraft(...args);
  } catch (error) {
    if (
      error instanceof InvoiceAmountError ||
      error instanceof InvoiceFinancialStateError
    ) {
      throw new HTTPException(error instanceof InvoiceAmountError ? 400 : 409, {
        message: error.message,
      });
    }
    throw error;
  }
}

async function updateInvoice(...args: Parameters<typeof persistInvoiceUpdate>) {
  try {
    return await persistInvoiceUpdate(...args);
  } catch (error) {
    if (error instanceof InvoiceFinancialStateError) {
      throw new HTTPException(409, { message: error.message });
    }
    throw error;
  }
}

async function issueInvoice(...args: Parameters<typeof persistInvoiceIssue>) {
  try {
    return await persistInvoiceIssue(...args);
  } catch (error) {
    if (error instanceof InvoiceFinancialStateError)
      throw new HTTPException(409, { message: error.message });
    throw error;
  }
}
async function scheduleInvoice(
  ...args: Parameters<typeof persistInvoiceSchedule>
) {
  try {
    return await persistInvoiceSchedule(...args);
  } catch (error) {
    if (error instanceof InvoiceFinancialStateError)
      throw new HTTPException(409, { message: error.message });
    throw error;
  }
}

async function deleteInvoice(...args: Parameters<typeof persistInvoiceDelete>) {
  try {
    return await persistInvoiceDelete(...args);
  } catch (error) {
    if (error instanceof InvoiceFinancialStateError) {
      throw new HTTPException(409, { message: error.message });
    }
    throw error;
  }
}

const app = new OpenAPIHono<Context>();

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "List all invoices",
    operationId: "listInvoices",
    "x-speakeasy-name-override": "list",
    description: "Retrieve a list of invoices for the authenticated team.",
    tags: ["Invoices"],
    request: {
      query: getInvoicesSchema,
    },
    responses: {
      200: {
        description: "A list of invoices for the authenticated team.",
        content: {
          "application/json": {
            schema: invoicesResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const { pageSize, cursor, sort, ...filter } = c.req.valid("query");

    const result = await getInvoices(db, {
      teamId,
      pageSize,
      cursor,
      sort,
      ...filter,
    });

    // Transform the data to add pdfUrl and previewUrl for each invoice
    const transformedResult = {
      ...result,
      data: result.data.map((invoice) => {
        const { token, ...invoiceWithoutToken } = invoice;

        return {
          ...invoiceWithoutToken,
          // Match the PDF, public HTML and payment amount. Reading an old
          // invoice must never rewrite its financial snapshot implicitly.
          subtotal:
            invoice.subtotal ??
            (invoice.amount == null
              ? null
              : getInvoiceSnapshotAmounts(invoice).subTotal),
          pdfUrl:
            token && process.env.MIDDAY_DASHBOARD_URL
              ? `${process.env.MIDDAY_DASHBOARD_URL}/api/download/invoice?token=${token}`
              : null,
          previewUrl:
            token && process.env.MIDDAY_DASHBOARD_URL
              ? `${process.env.MIDDAY_DASHBOARD_URL}/i/${token}`
              : null,
        };
      }),
    };

    return c.json(validateResponse(transformedResult, invoicesResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/payment-status",
    summary: "Payment status",
    operationId: "getInvoicePaymentStatus",
    "x-speakeasy-name-override": "paymentStatus",
    description: "Get payment status for the authenticated team.",
    tags: ["Invoices"],
    responses: {
      200: {
        description: "Payment status for the authenticated team.",
        content: {
          "application/json": {
            schema: getPaymentStatusResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");

    const result = await getPaymentStatus(db, teamId);

    return c.json(validateResponse(result, getPaymentStatusResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/summary",
    summary: "Invoice summary",
    operationId: "getInvoiceSummary",
    "x-speakeasy-name-override": "summary",
    description: "Get summary of invoices for the authenticated team.",
    tags: ["Invoices"],
    request: {
      query: invoiceSummarySchema,
    },
    responses: {
      200: {
        description: "Summary of invoices for the authenticated team.",
        content: {
          "application/json": {
            schema: invoiceSummaryResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const { statuses } = c.req.valid("query");

    const result = await getInvoiceSummary(db, {
      teamId,
      statuses,
    });

    return c.json(validateResponse(result, invoiceSummaryResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    summary: "Retrieve a invoice",
    operationId: "getInvoiceById",
    "x-speakeasy-name-override": "get",
    description:
      "Retrieve a invoice by its unique identifier for the authenticated team.",
    tags: ["Invoices"],
    request: {
      params: getInvoiceByIdSchema.pick({ id: true }),
    },
    responses: {
      200: {
        description:
          "Retrieve a invoice by its unique identifier for the authenticated team.",
        content: {
          "application/json": {
            schema: invoiceResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.read")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const { id } = c.req.valid("param");

    const result = await getInvoiceById(db, {
      id,
      teamId,
    });

    if (!result) {
      throw new HTTPException(404, { message: "Invoice not found" });
    }

    // Add PDF download and preview URLs and serialize objects like tRPC does with superjson
    const { token, ...resultWithoutToken } = result;

    const response = {
      ...resultWithoutToken,
      subtotal:
        result.subtotal ??
        (result.amount == null
          ? null
          : getInvoiceSnapshotAmounts(result).subTotal),
      paymentDetails: result.paymentDetails
        ? JSON.stringify(result.paymentDetails)
        : null,
      customerDetails: result.customerDetails
        ? JSON.stringify(result.customerDetails)
        : null,
      fromDetails: result.fromDetails
        ? JSON.stringify(result.fromDetails)
        : null,
      noteDetails: result.noteDetails
        ? JSON.stringify(result.noteDetails)
        : null,
      topBlock: result.topBlock ? JSON.stringify(result.topBlock) : null,
      bottomBlock: result.bottomBlock
        ? JSON.stringify(result.bottomBlock)
        : null,
      pdfUrl:
        token && process.env.MIDDAY_DASHBOARD_URL
          ? `${process.env.MIDDAY_DASHBOARD_URL}/api/download/invoice?token=${token}`
          : null,
      previewUrl:
        token && process.env.MIDDAY_DASHBOARD_URL
          ? `${process.env.MIDDAY_DASHBOARD_URL}/i/${token}`
          : null,
    };

    return c.json(validateResponse(response, invoiceResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    summary: "Create an invoice",
    operationId: "createInvoice",
    "x-speakeasy-name-override": "create",
    description:
      "Create an invoice for the authenticated team. The behavior depends on deliveryType: 'create' generates and finalizes the invoice immediately, 'create_and_send' also sends it to the customer, 'scheduled' schedules the invoice for automatic processing at the specified date.",
    tags: ["Invoices"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: draftInvoiceRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description:
          "Invoice created successfully. Status depends on deliveryType: 'scheduled' for scheduled invoices, 'unpaid' for create/create_and_send.",
        content: {
          "application/json": {
            schema: draftInvoiceResponseSchema,
          },
        },
      },
      400: {
        description: "Bad request. Invalid input data or validation errors.",
        content: {
          "application/json": {
            schema: z.object({
              message: z.string().openapi({
                description: "Error message describing the validation failure",
                examples: [
                  "scheduledAt is required for scheduled delivery",
                  "scheduledAt must be in the future",
                  "Invoice number 'INV-001' is already used. Please provide a different invoice number or omit it to auto-generate one.",
                ],
              }),
            }),
          },
        },
      },
      404: {
        description: "Customer not found.",
        content: {
          "application/json": {
            schema: z.object({
              message: z.string().openapi({
                description: "Error message",
                example: "Customer not found",
              }),
            }),
          },
        },
      },
      409: {
        description: "Conflict. Invoice number already exists.",
        content: {
          "application/json": {
            schema: z.object({
              message: z.string().openapi({
                description: "Error message about the conflict",
                example:
                  "Invoice number 'INV-2024-001' is already used. Please provide a different invoice number or omit it to auto-generate one.",
              }),
            }),
          },
        },
      },
      500: {
        description: "Internal server error.",
        content: {
          "application/json": {
            schema: z.object({
              message: z.string().openapi({
                description: "Error message",
                example: "Failed to create invoice",
              }),
            }),
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const userId = c.get("session").user.id;
    const input = c.req.valid("json");

    // Generate invoice ID and number if not provided
    const invoiceId = uuidv4();
    const finalInvoiceNumber =
      input.invoiceNumber || (await getNextInvoiceNumber(db, teamId));

    // Check if the provided invoice number is already used
    if (input.invoiceNumber) {
      const isUsed = await isInvoiceNumberUsed(db, teamId, finalInvoiceNumber);
      if (isUsed) {
        throw new HTTPException(409, {
          message: `Invoice number '${finalInvoiceNumber}' is already used. Please provide a different invoice number or omit it to auto-generate one.`,
        });
      }
    }

    // Get template for default payment terms
    const template = await getInvoiceTemplate(db, teamId);
    const paymentTermsDays = template?.paymentTermsDays ?? 30;

    // Set default dates if not provided
    const issueDate = input.issueDate || new Date().toISOString();
    const dueDate =
      input.dueDate ||
      addDays(new Date(issueDate), paymentTermsDays).toISOString();

    // Fetch customer and generate customerDetails
    const customer = await getCustomerById(db, {
      id: input.customerId,
      teamId,
    });

    if (!customer) {
      throw new HTTPException(404, { message: "Customer not found" });
    }

    const customerDetails = transformCustomerToContent(customer);

    const result = await draftInvoice(db, {
      id: invoiceId,
      teamId,
      userId,
      invoiceNumber: finalInvoiceNumber,
      issueDate,
      dueDate,
      template: input.template,
      paymentDetails: input.paymentDetails,
      fromDetails: input.fromDetails,
      customerDetails: customerDetails ? JSON.stringify(customerDetails) : null,
      noteDetails: input.noteDetails,
      customerId: input.customerId,
      customerName: customer.name,
      logoUrl: input.logoUrl,
      vat: input.vat,
      tax: input.tax,
      discount: input.discount,
      topBlock: input.topBlock,
      bottomBlock: input.bottomBlock,
      amount: input.amount,
      subtotal: input.subtotal,
      lineItems: input.lineItems?.map((item) => ({
        ...item,
        name: JSON.stringify(item.name),
      })),
    });

    if (!result) {
      throw new HTTPException(500, { message: "Failed to create invoice" });
    }

    const finalResult =
      input.deliveryType === "scheduled"
        ? await scheduleInvoice(db, {
            id: result.id,
            teamId,
            userId,
            scheduledAt: input.scheduledAt ?? "",
          })
        : input.deliveryType === "create" ||
            input.deliveryType === "create_and_send"
          ? await issueInvoice(db, {
              id: result.id,
              teamId,
              userId,
              deliveryType: input.deliveryType,
            })
          : result;
    if (!finalResult)
      throw new HTTPException(404, { message: "Invoice not found" });

    // Add PDF download and preview URLs and serialize objects like tRPC does with superjson
    const { token, ...resultWithoutToken } = finalResult;
    const response = {
      ...resultWithoutToken,
      paymentDetails: result.paymentDetails
        ? JSON.stringify(result.paymentDetails)
        : null,
      customerDetails: result.customerDetails
        ? JSON.stringify(result.customerDetails)
        : null,
      fromDetails: result.fromDetails
        ? JSON.stringify(result.fromDetails)
        : null,
      noteDetails: result.noteDetails
        ? JSON.stringify(result.noteDetails)
        : null,
      topBlock: result.topBlock ? JSON.stringify(result.topBlock) : null,
      bottomBlock: result.bottomBlock
        ? JSON.stringify(result.bottomBlock)
        : null,
      pdfUrl:
        token && process.env.MIDDAY_DASHBOARD_URL
          ? `${process.env.MIDDAY_DASHBOARD_URL}/api/download/invoice?token=${token}`
          : null,
      previewUrl:
        token && process.env.MIDDAY_DASHBOARD_URL
          ? `${process.env.MIDDAY_DASHBOARD_URL}/i/${token}`
          : null,
    };

    return c.json(validateResponse(response, draftInvoiceResponseSchema), 201);
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    summary: "Update an invoice",
    operationId: "updateInvoice",
    "x-speakeasy-name-override": "update",
    description:
      "Update an invoice by its unique identifier for the authenticated team.",
    tags: ["Invoices"],
    request: {
      params: getInvoiceByIdSchema.pick({ id: true }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: updateInvoiceRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Invoice updated successfully.",
        content: {
          "application/json": {
            schema: updateInvoiceResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const userId = c.get("session").user.id;
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    const changed = await updateInvoice(db, {
      id,
      teamId,
      userId,
      ...input,
    });
    if (!changed)
      throw new HTTPException(404, { message: "Invoice not found" });

    const result = await getInvoiceById(db.usePrimaryOnly(), { id, teamId });

    if (!result) {
      throw new HTTPException(404, { message: "Invoice not found" });
    }

    const { token, ...resultWithoutToken } = result;
    const response = {
      ...resultWithoutToken,
      ...("operation" in changed ? { operation: changed.operation } : {}),
      paymentDetails: result.paymentDetails
        ? JSON.stringify(result.paymentDetails)
        : null,
      customerDetails: result.customerDetails
        ? JSON.stringify(result.customerDetails)
        : null,
      fromDetails: result.fromDetails
        ? JSON.stringify(result.fromDetails)
        : null,
      noteDetails: result.noteDetails
        ? JSON.stringify(result.noteDetails)
        : null,
      topBlock: result.topBlock ? JSON.stringify(result.topBlock) : null,
      bottomBlock: result.bottomBlock
        ? JSON.stringify(result.bottomBlock)
        : null,
      pdfUrl:
        token && process.env.MIDDAY_DASHBOARD_URL
          ? `${process.env.MIDDAY_DASHBOARD_URL}/api/download/invoice?token=${token}`
          : null,
      previewUrl:
        token && process.env.MIDDAY_DASHBOARD_URL
          ? `${process.env.MIDDAY_DASHBOARD_URL}/i/${token}`
          : null,
    };

    return c.json(validateResponse(response, updateInvoiceResponseSchema));
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    summary: "Delete a invoice",
    operationId: "deleteInvoice",
    "x-speakeasy-name-override": "delete",
    description:
      "Delete an invoice by its unique identifier for the authenticated team. Only invoices with status 'draft' or 'canceled' can be deleted directly. If the invoice is not in one of these statuses, update its status to 'canceled' before attempting deletion.",
    tags: ["Invoices"],
    request: {
      params: deleteInvoiceSchema.pick({ id: true }),
    },
    responses: {
      200: {
        description:
          "Delete a invoice by its unique identifier for the authenticated team.",
        content: {
          "application/json": {
            schema: deleteInvoiceResponseSchema,
          },
        },
      },
    },
    middleware: [withRequiredScope("invoices.write")],
  }),
  async (c) => {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const { id } = c.req.valid("param");

    const result = await deleteInvoice(db, {
      id,
      teamId,
    });

    return c.json(validateResponse(result, deleteInvoiceResponseSchema));
  },
);

export const invoicesRouter = app;
