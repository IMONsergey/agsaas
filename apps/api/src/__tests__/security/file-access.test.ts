import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateFileKey } from "@midday/encryption";
import { StorageClient } from "@supabase/storage-js";
import { SignJWT } from "jose";

// Run separately: module mocks deliberately replace infrastructure, not the
// actual file-key signer/verifier, route schemas, or storage path validation.
const teamA = "11111111-1111-4111-8111-111111111111";
const teamB = "22222222-2222-4222-8222-222222222222";
const previousSecret = process.env.FILE_KEY_SECRET;
const previousFetch = globalThis.fetch;
const storagePaths: string[] = [];
const objectKeys: string[] = [];
let fileKey: string;

globalThis.fetch = (() => {
  throw new Error("Unexpected network access in file boundary tests");
}) as typeof fetch;

// Exercise the real SDK URL construction. The fake transport observes the URL
// a real Request would send, then returns synthetic content without networking.
const storage = new StorageClient(
  "https://storage.invalid/storage/v1",
  {},
  async (input, init) => {
    storagePaths.push(new URL(new Request(input, init).url).pathname);
    return new Response("synthetic file fixture", {
      headers: { "Content-Type": "text/plain" },
    });
  },
);
const originalFrom = storage.from.bind(storage);
storage.from = (bucket) => {
  const api = originalFrom(bucket);
  const originalDownload = api.download.bind(api);
  api.download = (path, ...args) => {
    objectKeys.push(path);
    return originalDownload(path, ...args);
  };
  return api;
};

mock.module("@api/services/supabase", () => ({
  createAdminClient: async () => ({ storage }),
}));
mock.module("@midday/cache/team-cache", () => ({
  teamCache: { get: async () => undefined, set: async () => {} },
}));
mock.module("@midday/db/client", () => ({ db: {} }));
mock.module("@midday/db/queries", () => ({
  hasTeamAccess: async () => false,
  getInvoiceById: async () => null,
}));
mock.module("@midday/invoice", () => ({
  PdfTemplate() {},
  renderToStream() {},
}));
mock.module("@midday/invoice/token", () => ({ verify: async () => null }));
mock.module("../../rest/middleware/index.ts", () => ({ publicMiddleware: [] }));

const { downloadRouter } = await import("../../rest/routers/files/download");
const { serveRouter } = await import("../../rest/routers/files/serve");

beforeAll(async () => {
  process.env.FILE_KEY_SECRET = crypto.randomUUID();
  fileKey = await generateFileKey(teamA);
});

beforeEach(() => {
  storagePaths.length = 0;
  objectKeys.length = 0;
});

afterAll(() => {
  globalThis.fetch = previousFetch;
  if (previousSecret === undefined) delete process.env.FILE_KEY_SECRET;
  else process.env.FILE_KEY_SECRET = previousSecret;
});

describe("file-key resource boundaries", () => {
  for (const [name, app, route, parameter] of [
    ["proxy", serveRouter, "/proxy", "filePath"],
    ["download", downloadRouter, "/file", "path"],
  ] as const) {
    test(`${name}: accepts own-team files and the documented vault prefix`, async () => {
      const key = `${teamA}/Выписки/Счёт 1.pdf`;
      const response = await app.request(
        `${route}?${new URLSearchParams({ [parameter]: `vault/${key}`, fk: fileKey })}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("synthetic file fixture");
      expect(objectKeys).toEqual([key]);
      expect(storagePaths).toEqual([
        new URL(`https://storage.invalid/storage/v1/object/vault/${key}`).pathname,
      ]);
    });

    test(`${name}: rejects a directly supplied foreign-team path`, async () => {
      const response = await app.request(
        `${route}?${new URLSearchParams({ [parameter]: `${teamB}/private.pdf`, fk: fileKey })}`,
      );
      expect(response.status).toBe(401);
      expect(storagePaths).toEqual([]);
    });

    test(`${name}: rejects duplicate path parameters`, async () => {
      const query = new URLSearchParams({ [parameter]: `${teamA}/own.pdf`, fk: fileKey });
      query.append(parameter, `${teamB}/private.pdf`);
      expect((await app.request(`${route}?${query}`)).status).toBe(400);
      expect(storagePaths).toEqual([]);
    });

    for (const [index, path] of [
      `${teamA}/../${teamB}/private.pdf`,
      `${teamA}/%2e%2e/${teamB}/private.pdf`,
      `${teamA}/%252e%252e/${teamB}/private.pdf`,
      `${teamA}/../../other-bucket/private.pdf`,
      `${teamA}/folder\\..\\private.pdf`,
      `${teamA}/file.pdf?override=1`,
      `${teamA}/file.pdf#fragment`,
      `${teamA}//file.pdf`,
      `${teamA}/file%00.pdf`,
    ].entries()) {
      test(`${name}: rejects traversal/URL ambiguity ${index + 1} before storage`, async () => {
        const response = await app.request(
          `${route}?${new URLSearchParams({ [parameter]: path, fk: fileKey })}`,
        );
        expect(response.status).toBe(400);
        expect(storagePaths).toEqual([]);
      });
    }
  }

  test("download does not authorize a decoy filePath instead of path", async () => {
    const query = new URLSearchParams({
      filePath: `${teamA}/decoy.pdf`,
      path: `${teamB}/private.pdf`,
      fk: fileKey,
    });
    expect((await downloadRouter.request(`/file?${query}`)).status).toBe(401);
    expect(storagePaths).toEqual([]);
  });

  test("proxy cannot use a path alias to authorize another filePath", async () => {
    const query = new URLSearchParams({
      filePath: `${teamB}/private.pdf`,
      path: `${teamA}/decoy.pdf`,
      fk: fileKey,
    });
    expect((await serveRouter.request(`/proxy?${query}`)).status).toBe(401);
    expect(storagePaths).toEqual([]);
  });

  test("requires a genuinely signed file key", async () => {
    const forged = await new SignJWT({ teamId: teamA })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(crypto.randomUUID()));
    const query = new URLSearchParams({ filePath: `${teamA}/file.pdf`, fk: forged });
    expect((await serveRouter.request(`/proxy?${query}`)).status).toBe(401);
    expect(storagePaths).toEqual([]);
  });

  test("rejects missing keys without touching storage", async () => {
    expect((await serveRouter.request(`/proxy?filePath=${teamA}/file.pdf`)).status).toBe(401);
    expect(storagePaths).toEqual([]);
  });
});
