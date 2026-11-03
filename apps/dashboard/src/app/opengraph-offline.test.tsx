import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Socket } from "node:net";
import { join } from "node:path";
import sharp from "sharp";
import { syntheticInvoice } from "../../../../packages/invoice/src/test/fixtures/invoice";

const ownOrigin = "https://storage.agsaas.example.test:8549";
const ownLogo = `${ownOrigin}/storage/v1/object/public/avatars/teams/11111111-1111-4111-8111-111111111111/invoice/logo.png`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const idatOffset = png.indexOf("IDAT");
if (idatOffset < 4) throw new Error("The valid PNG fixture must contain IDAT");
const idatCrcOffset = idatOffset + 4 + png.readUInt32BE(idatOffset - 4);
const badCrcPng = Buffer.from(png);
badCrcPng[idatCrcOffset] = badCrcPng[idatCrcOffset]! ^ 0xff;
const brokenIdatPng = Buffer.from(png);
brokenIdatPng[idatOffset + 4] = 0; // Invalid zlib header, with a plausible IHDR.
const malformedPngs = [
  ["bad-crc", badCrcPng],
  ["broken-idat", brokenIdatPng],
  ["truncated-ihdr", png.subarray(0, 24)],
] as const;
const routeKinds = ["invoice", "portal", "report"] as const;
type OgRoute = (typeof routeKinds)[number];
let logoBytes = Uint8Array.from(png);
let logoMime = "image/png";
const priorFetch = globalThis.fetch;
const priorConnect = Socket.prototype.connect;
const priorStorage = process.env.NEXT_PUBLIC_SUPABASE_URL;
let requests: string[] = [];
let invoice: unknown = null;
let portal: unknown = null;
let report: unknown = null;
// Generic Bun has no react-server condition; keep this boundary mock in tests.
mock.module("server-only", () => ({}));
mock.module("@/trpc/server", () => ({
  getQueryClient: () => ({
    fetchQuery: async (options: { kind: string }) =>
      options.kind === "invoice"
        ? invoice
        : options.kind === "portal"
          ? portal
          : report,
  }),
  trpc: {
    invoice: {
      getInvoiceByToken: { queryOptions: () => ({ kind: "invoice" }) },
    },
    customers: { getByPortalId: { queryOptions: () => ({ kind: "portal" }) } },
    reports: { getByLinkId: { queryOptions: () => ({ kind: "report" }) } },
  },
}));
let invoiceImage: typeof import("./[locale]/(public)/i/[token]/opengraph-image").default;
let portalImage: typeof import("./[locale]/(public)/p/[portalId]/opengraph-image").default;
let reportImage: typeof import("./[locale]/(public)/r/[linkId]/opengraph-image").default;
let loadPublicOgLogo: typeof import("@/utils/public-og-logo.server").loadPublicOgLogo;
beforeEach(() => {
  logoBytes = Uint8Array.from(png);
  logoMime = "image/png";
  requests = [];
});
beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ownOrigin;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url !== ownLogo) throw new Error("External OG network forbidden");
      return new Response(logoBytes, { headers: { "content-type": logoMime } });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  Socket.prototype.connect = (() => {
    throw new Error("External OG socket forbidden");
  }) as typeof Socket.prototype.connect;
  ({ loadPublicOgLogo } = await import("@/utils/public-og-logo.server"));
  invoiceImage = (await import("./[locale]/(public)/i/[token]/opengraph-image"))
    .default;
  portalImage = (
    await import("./[locale]/(public)/p/[portalId]/opengraph-image")
  ).default;
  reportImage = (await import("./[locale]/(public)/r/[linkId]/opengraph-image"))
    .default;
});
afterAll(() => {
  globalThis.fetch = priorFetch;
  Socket.prototype.connect = priorConnect;
  if (priorStorage === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = priorStorage;
  mock.restore();
});
function setFixtures(logo: string | null, name = "Компания AGSaaS") {
  invoice = {
    ...syntheticInvoice,
    customerName: name,
    template: { ...syntheticInvoice.template, logoUrl: logo },
    fromDetails: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: name }] }],
    },
  };
  portal = {
    customer: { name: "Заказчик", team: { name, logoUrl: logo } },
    summary: {
      totalAmount: 100,
      paidAmount: 75,
      outstandingAmount: 25,
      currency: "USD",
      invoiceCount: 2,
    },
  };
  report = {
    teamName: name,
    teamLogoUrl: logo,
    type: "profit",
    from: "2026-10-01",
    to: "2026-10-31",
    expireAt: null,
  };
}
async function renderRoute(kind: OgRoute) {
  return kind === "invoice"
    ? invoiceImage({ params: Promise.resolve({ token: "fixture" }) })
    : kind === "portal"
      ? portalImage({ params: Promise.resolve({ portalId: "fixture" }) })
      : reportImage({ params: Promise.resolve({ linkId: "fixture" }) });
}
async function expectPng(response: Response, name: string) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(16)).toBe(1200);
  expect(bytes.readUInt32BE(20)).toBe(630);
  expect(bytes.byteLength).toBeGreaterThan(1000);
  if (process.env.AGSAAS_RENDER_ARTIFACT_DIR)
    await Bun.write(
      join(process.env.AGSAAS_RENDER_ARTIFACT_DIR, `${name}.png`),
      bytes,
    );
}
describe("actual public OG routes with own fonts and no external network", () => {
  test.each(
    routeKinds,
  )("renders the %s route with an own logo fetched exactly once", async (kind) => {
    setFixtures(ownLogo);
    await expectPng(await renderRoute(kind), `own-${kind}-og`);
    expect(requests).toEqual([ownLogo]);
  });
  test.each(
    malformedPngs,
  )("fully decodes and rejects a header-valid optional logo: %s", async (_name, bytes) => {
    logoBytes = Uint8Array.from(bytes);
    expect(await loadPublicOgLogo(ownLogo)).toBeNull();
    expect(requests).toEqual([ownLogo]);
  });
  test.each(
    malformedPngs.flatMap(([name, bytes]) =>
      routeKinds.map((kind) => [kind, name, bytes] as const),
    ),
  )("renders the actual %s route when its own logo is %s", async (kind, name, bytes) => {
    setFixtures(ownLogo);
    logoBytes = Uint8Array.from(bytes);
    await expectPng(await renderRoute(kind), `fallback-${kind}-${name}-og`);
    expect(requests).toEqual([ownLogo]);
  });
  test("decodes a valid wide JPEG into a bounded inline PNG without refetching", async () => {
    logoBytes = new Uint8Array(
      await sharp({
        create: {
          width: 2048,
          height: 4,
          channels: 3,
          background: "#ed3344",
        },
      })
        .jpeg()
        .toBuffer(),
    );
    logoMime = "image/jpeg";
    const inline = await loadPublicOgLogo(ownLogo);
    expect(inline?.startsWith("data:image/png;base64,")).toBe(true);
    if (!inline) throw new Error("The valid own JPEG must be retained");
    const normalized = Buffer.from(
      inline.slice(inline.indexOf(",") + 1),
      "base64",
    );
    expect([...normalized.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(normalized.readUInt32BE(16)).toBe(1024);
    expect(normalized.readUInt32BE(20)).toBe(2);
    expect(requests).toEqual([ownLogo]);
  });
  test.each([
    "file:///etc/hostname",
    "http://169.254.169.254/latest/meta-data/",
    "https://cdn.midday.ai/logo.png",
  ])("never fetches a persisted untrusted logo in any route: %s", async (logo) => {
    setFixtures(logo);
    requests = [];
    await expectPng(
      await invoiceImage({ params: Promise.resolve({ token: "fixture" }) }),
      "safe-invoice-og",
    );
    await expectPng(
      await portalImage({ params: Promise.resolve({ portalId: "fixture" }) }),
      "safe-portal-og",
    );
    await expectPng(
      await reportImage({ params: Promise.resolve({ linkId: "fixture" }) }),
      "safe-report-og",
    );
    expect(requests).toEqual([]);
  });
  test("unsupported glyphs cannot silently fetch a font or emoji from a CDN", async () => {
    setFixtures(null, "Компания 🚀 中文");
    requests = [];
    await expectPng(
      await portalImage({ params: Promise.resolve({ portalId: "fixture" }) }),
      "own-missing-glyph-og",
    );
    expect(requests).toEqual([]);
  });
  test("missing public records do not render or fetch a logo", async () => {
    invoice = portal = report = null;
    requests = [];
    expect(
      (await invoiceImage({ params: Promise.resolve({ token: "missing" }) }))
        .status,
    ).toBe(404);
    expect(
      (await portalImage({ params: Promise.resolve({ portalId: "missing" }) }))
        .status,
    ).toBe(404);
    await expect(
      reportImage({ params: Promise.resolve({ linkId: "missing" }) }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });
  test("expired report is rejected before fetching its own logo", async () => {
    setFixtures(ownLogo);
    report = { ...(report as Record<string, unknown>), expireAt: "2020-01-01" };
    requests = [];
    await expect(
      reportImage({ params: Promise.resolve({ linkId: "expired" }) }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
