import { beforeEach, describe, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "../rest/types";

const ID = "00000000-0000-4000-8000-000000000003";
const TEAM = "00000000-0000-4000-8000-000000000001";
const getPublished = mock(async (): Promise<any> => null);
const getDocument = mock(async (): Promise<any> => null);
const access = mock(async () => ({ userId: "fixture-user", teamId: TEAM }));
const token = mock(async () => ({ id: ID }));
const render = mock(
  async () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("%PDF-fixture"));
        controller.close();
      },
    }),
);

mock.module("@api/rest/middleware", () => ({
  publicMiddleware: [async (_c: unknown, next: () => Promise<void>) => next()],
}));
mock.module("@api/rest/middleware/db", () => ({
  withDatabase: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@api/rest/middleware/ip", () => ({
  withClientIp: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@api/rest/middleware/file-auth", () => ({
  withFileAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@api/utils/file-access", () => ({ requireFileAccess: access }));
mock.module("@api/services/supabase", () => ({
  createAdminClient: async () => {
    throw new Error("Unexpected Storage request");
  },
}));
mock.module("@midday/db/queries", () => ({
  getPublishedInvoiceById: getPublished,
  getInvoiceDocumentById: getDocument,
  hasTeamAccess: async () => false,
}));
mock.module("@midday/invoice/token", () => ({ verify: token }));
mock.module("@midday/invoice", () => ({
  PdfTemplate: async (data: unknown) => data,
  renderToStream: render,
}));

const { downloadRouter } = await import("../rest/routers/files/download");
const { attachmentDisposition } = await import("../rest/routers/files/utils");
const app = new OpenAPIHono<Context>();
app.use("*", async (c, next) => {
  c.set("db", {} as Context["Variables"]["db"]);
  await next();
});
app.route("/download", downloadRouter);

beforeEach(() => {
  for (const fn of [getPublished, getDocument, access, token, render])
    fn.mockClear();
  getPublished.mockImplementation(async () => null);
  getDocument.mockImplementation(async () => null);
});

describe("invoice PDF publication and authenticated preview", () => {
  test("an unpublished valid-token invoice cannot reach rendering", async () => {
    const response = await app.request(
      "/download/invoice?token=fixture-valid-token",
    );
    expect(response.status).toBe(404);
    expect(getPublished).toHaveBeenCalledWith(expect.anything(), { id: ID });
    expect(getDocument).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });
  test("an authenticated draft preview uses the credential team", async () => {
    getDocument.mockImplementation(async () => ({
      id: ID,
      status: "draft",
      template: {},
      invoiceNumber: "DRAFT-1",
    }));
    const response = await app.request(
      `/download/invoice?id=${ID}&fk=fixture&preview=true`,
    );
    expect(response.status).toBe(200);
    expect(access).toHaveBeenCalledWith(expect.anything(), "invoices.read");
    expect(getDocument).toHaveBeenCalledWith(expect.anything(), {
      id: ID,
      teamId: TEAM,
    });
    expect(getPublished).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain(
      "private, no-store",
    );
  });
  test("a published invoice renders with no shared cache or referrer leakage", async () => {
    getPublished.mockImplementation(async () => ({
      id: ID,
      status: "unpaid",
      template: {},
      invoiceNumber: "INV-1",
    }));
    const response = await app.request(
      "/download/invoice?token=fixture-valid-token",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toStartWith("%PDF-");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  test("legacy filenames cannot inject response headers", () => {
    const value = attachmentDisposition('INV-1"\r\nX-Injected: yes/Отчет.pdf');
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value).toContain("filename*=UTF-8''");
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
  });
});
