import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { join } from "node:path";
import { PdfTemplate, renderToBuffer } from "@midday/invoice";
import { syntheticInvoice } from "../../../../../packages/invoice/src/test/fixtures/invoice";
import {
  documentInputBase64,
  runDocumentTask,
} from "../../utils/document-isolation";

const priorFetch = globalThis.fetch;
const priorConnect = Socket.prototype.connect;
const priorEnv = {
  DASHBOARD_URL: process.env.DASHBOARD_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
};
const origin = "https://storage.agsaas.example.test:8549";
const logo =
  origin +
  "/storage/v1/object/public/avatars/teams/11111111-1111-4111-8111-111111111111/invoice/logo.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
let requests: string[] = [];
beforeAll(() => {
  process.env.DASHBOARD_URL = "https://dashboard.agsaas.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = origin;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url !== logo) throw new Error("External document network forbidden");
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  Socket.prototype.connect = (() => {
    throw new Error("External document socket forbidden");
  }) as typeof Socket.prototype.connect;
});
afterAll(() => {
  globalThis.fetch = priorFetch;
  Socket.prototype.connect = priorConnect;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
describe("actual offline invoice PDF", () => {
  test.each([
    false,
    true,
  ])("renders %s receipt mode with Latin and Cyrillic text using bundled fonts", async (isReceipt) => {
    requests = [];
    const invoice = {
      ...syntheticInvoice,
      invoiceNumber: "OWN-001",
      paidAt: isReceipt ? "2026-11-03T00:00:00.000Z" : null,
      template: {
        ...syntheticInvoice.template,
        logoUrl: null,
        includeQr: false,
        title: "Счёт",
      },
      lineItems: [{ name: "Разработка AGSaaS", quantity: 1, price: 100 }],
    };
    const buffer = await renderToBuffer(
      await PdfTemplate(invoice, { isReceipt }),
    );
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.byteLength).toBeGreaterThan(2000);
    const text = await runDocumentTask(
      {
        kind: "parse",
        base64: documentInputBase64(buffer),
        mimetype: "application/pdf",
      },
      { timeoutMs: 10000 },
    );
    expect(text).toContain("OWN-001");
    expect(text).toContain("Разработка");
    expect(text).toContain("AGSaaS");
    expect(requests).toEqual([]);
    if (process.env.AGSAAS_RENDER_ARTIFACT_DIR)
      await Bun.write(
        join(
          process.env.AGSAAS_RENDER_ARTIFACT_DIR,
          isReceipt ? "own-receipt.pdf" : "own-invoice.pdf",
        ),
        buffer,
      );
  });
  test("fetches the own logo once and embeds its bytes without giving the renderer a URL", async () => {
    requests = [];
    const buffer = await renderToBuffer(
      await PdfTemplate({
        ...syntheticInvoice,
        template: {
          ...syntheticInvoice.template,
          includeQr: false,
          logoUrl: logo,
        },
      }),
    );
    expect(requests).toEqual([logo]);
    expect(buffer.toString("latin1")).toContain("/Subtype /Image");
  });
  test.each([
    "file:///etc/hostname",
    "http://169.254.169.254/latest/meta-data/",
    "https://cdn.midday.ai/logo.png",
  ])("ignores an unsafe persisted logo without any HTTP or local-file image read: %s", async (logoUrl) => {
    requests = [];
    const buffer = await renderToBuffer(
      await PdfTemplate({
        ...syntheticInvoice,
        template: { ...syntheticInvoice.template, includeQr: false, logoUrl },
      }),
    );
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(requests).toEqual([]);
    expect(buffer.toString("latin1")).not.toContain("/Subtype /Image");
  });
});
