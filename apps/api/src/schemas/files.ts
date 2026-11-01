import { z } from "@hono/zod-openapi";

export const proxyFileSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .openapi({
      description:
        "Path to the file in storage. Can include or exclude 'vault/' prefix.",
      example:
        "vault/b3b7c1e2-4c2a-4e7a-9c1a-2b7c1e24c2a4/documents/invoice.pdf",
      param: {
        in: "query",
        name: "filePath",
        required: true,
      },
    }),
  fk: z
    .string()
    .min(1)
    .optional()
    .openapi({
      description:
        "Short-lived user-bound file capability. Membership is checked on every request. Alternatively use an Authorization Bearer token with the required file scope.",
      example: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      param: {
        in: "query",
        name: "fk",
        required: false,
      },
    }),
});

export const downloadFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .openapi({
      description:
        "Path to the file in storage. Can include or exclude 'vault/' prefix.",
      example:
        "vault/b3b7c1e2-4c2a-4e7a-9c1a-2b7c1e24c2a4/documents/invoice.pdf",
      param: {
        in: "query",
        name: "path",
        required: true,
      },
    }),
  filename: z
    .string()
    .optional()
    .openapi({
      description: "Optional filename for the Content-Disposition header.",
      example: "invoice.pdf",
      param: {
        in: "query",
        name: "filename",
      },
    }),
  fk: z
    .string()
    .min(1)
    .optional()
    .openapi({
      description:
        "Short-lived user-bound file capability. Membership is checked on every request. Alternatively use an Authorization Bearer token with the required file scope.",
      example: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      param: {
        in: "query",
        name: "fk",
        required: false,
      },
    }),
});

export const downloadInvoiceSchema = z.object({
  id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      description:
        "Invoice ID (UUID). Requires team file key (fk) query parameter for authentication.",
      example: "b3b7c1e2-4c2a-4e7a-9c1a-2b7c1e24c2a4",
      param: {
        in: "query",
        name: "id",
      },
    }),
  fk: z
    .string()
    .min(1)
    .optional()
    .openapi({
      description:
        "Short-lived user-bound file capability for authenticated invoice access. An Authorization Bearer token with invoices.read can be used instead.",
      example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      param: {
        in: "query",
        name: "fk",
      },
    }),
  token: z
    .string()
    .optional()
    .openapi({
      description:
        "Invoice access token for public access. When used alone (without id), allows access to a published invoice. Draft, scheduled and canceled invoices are private.",
      example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      param: {
        in: "query",
        name: "token",
      },
    }),
  preview: z
    .preprocess(
      (val) => val === "true" || val === true,
      z.boolean().default(false),
    )
    .optional()
    .openapi({
      description:
        "If true, the PDF will be displayed inline. If false, it will be downloaded.",
      example: false,
      param: {
        in: "query",
        name: "preview",
      },
    }),
  type: z
    .enum(["invoice", "receipt"])
    .optional()
    .default("invoice")
    .openapi({
      description:
        "Type of document to download. Use 'receipt' to download a receipt for paid invoices.",
      example: "invoice",
      param: {
        in: "query",
        name: "type",
      },
    }),
});
