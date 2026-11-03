import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { embedInvoiceLogoForDisplay } from "../services/invoice-display-assets";

const originalFetch = globalThis.fetch;
const originalStorage = process.env.NEXT_PUBLIC_SUPABASE_URL;
const origin = "https://storage.agsaas.example.test:8549";
const own = `${origin}/storage/v1/object/public/avatars/teams/11111111-1111-4111-8111-111111111111/invoice/logo.png`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
let requests: string[] = [];
beforeEach(() => {
  requests = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = origin;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url !== own) throw new Error("Foreign logo request forbidden");
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined)
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalStorage;
});
describe("MCP invoice display images", () => {
  test("embeds one bounded own Storage request and preserves other invoice data", async () => {
    const invoice = {
      id: "fixture",
      amount: 100,
      template: { logoUrl: own, title: "Invoice" },
    };
    const result = await embedInvoiceLogoForDisplay(invoice);
    expect(result).toEqual({
      ...invoice,
      template: {
        ...invoice.template,
        logoUrl: `data:image/png;base64,${png.toString("base64")}`,
      },
    });
    expect(invoice.template.logoUrl).toBe(own);
    expect(requests).toEqual([own]);
  });
  test.each([
    "file:///etc/hostname",
    "http://169.254.169.254/latest/meta-data/",
    "https://service.midday.ai/logo.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    `data:image/png;base64,${png.toString("base64")}`,
  ])("strips persisted untrusted image references without a request", async (logoUrl) => {
    const result = await embedInvoiceLogoForDisplay({
      id: "fixture",
      template: { logoUrl },
    });
    expect(result.template.logoUrl).toBeNull();
    expect(requests).toEqual([]);
  });
});
