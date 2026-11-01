import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import QRCodeUtil from "qrcode";
import { isValidElement } from "react";
import { DEFAULT_TEMPLATE } from "../../defaults";
import type { Invoice } from "../../types";
import { QRCode } from "./components/qr-code";
import { PdfTemplate } from "./index";

const envNames = [
  "DASHBOARD_URL",
  "NEXT_PUBLIC_URL",
  "NODE_ENV",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_PUBLIC_DOMAIN",
];
const originalEnv = Object.fromEntries(
  envNames.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: "production" });
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const invoice: Invoice = {
  id: "34e90994-f02a-4ae3-987e-ced47fc02c1b",
  dueDate: "2026-12-01T00:00:00.000Z",
  invoiceNumber: "QR-001",
  createdAt: "2026-11-01T00:00:00.000Z",
  amount: 100,
  subtotal: 100,
  currency: "USD",
  lineItems: [{ name: "QR regression", quantity: 1, price: 100 }],
  paymentDetails: null,
  customerDetails: null,
  reminderSentAt: null,
  updatedAt: null,
  note: null,
  internalNote: null,
  paidAt: null,
  vat: null,
  tax: null,
  filePath: null,
  status: "unpaid",
  viewedAt: null,
  fromDetails: null,
  issueDate: "2026-11-01T00:00:00.000Z",
  sentAt: null,
  template: { ...DEFAULT_TEMPLATE },
  noteDetails: null,
  customerName: null,
  token: "fixture-invoice-token",
  sentTo: null,
  discount: null,
  topBlock: null,
  bottomBlock: null,
  customer: null,
  customerId: null,
  team: null,
};

function qrData(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const data = qrData(child);
      if (data !== null) return data;
    }
    return null;
  }
  if (!isValidElement<{ children?: unknown; data?: string }>(node)) return null;
  if (node.type === QRCode) return node.props.data ?? null;
  return qrData(node.props.children);
}

function digest(data: string | null): string {
  if (data === null) throw new Error("PDF template is missing its QR image");
  return createHash("sha256").update(data).digest("hex");
}

describe("PDF invoice QR destination", () => {
  // Exercise the real template and QR encoder without rendering fonts or using HTTP.
  for (const isReceipt of [false, true]) {
    test.each([
      {
        dashboardUrl: "https://94.249.186.240:8543",
        expectedOrigin: "https://94.249.186.240:8543",
      },
      {
        dashboardUrl: "http://localhost:3300",
        expectedOrigin: "http://localhost:3300",
      },
      {
        dashboardUrl: undefined,
        expectedOrigin: "http://localhost:3001",
      },
    ])(`uses $expectedOrigin for ${isReceipt ? "receipt" : "invoice"} QR`, async ({
      dashboardUrl,
      expectedOrigin,
    }) => {
      if (dashboardUrl) process.env.DASHBOARD_URL = dashboardUrl;
      const document = await PdfTemplate(invoice, { isReceipt });
      const expected = await QRCodeUtil.toDataURL(
        `${expectedOrigin}/i/${invoice.token}`,
        { margin: 0, width: 120 },
      );
      expect(digest(qrData(document))).toBe(digest(expected));
    });
  }

  test("omits the QR image when the template disables it", async () => {
    process.env.DASHBOARD_URL = "https://94.249.186.240:8543";
    const document = await PdfTemplate({
      ...invoice,
      template: { ...invoice.template, includeQr: false },
    });
    expect(qrData(document)).toBeNull();
  });
});
