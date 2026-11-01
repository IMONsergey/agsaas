import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseFetch } from "../client/server-fetch";
import { download, remove, signedUrl, upload } from "./storage";
import { InvalidStorageKeyError, validateVaultKey } from "./storage-path";

const OWN_TEAM = "00000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "00000000-0000-4000-8000-000000000002";
const INVALID_KEYS = [
  `${OWN_TEAM}/../${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}/invoices/../../${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}/%2e%2e/${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}/.%2E/${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}/%252e%252e/${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}%2f..%2f${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}/invoices\\..\\..\\${OTHER_TEAM}/private.pdf`,
  `${OWN_TEAM}/./private.pdf`,
  `${OWN_TEAM}//private.pdf`,
  `${OWN_TEAM}/private.pdf?other=1`,
  `${OWN_TEAM}/private.pdf#fragment`,
  `${OWN_TEAM}/invoices/\n../private.pdf`,
  `/${OWN_TEAM}/private.pdf`,
  `${OWN_TEAM}/`,
];

function captureClient() {
  const requests: { url: URL; method: string }[] = [];
  const capture = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({
        url: new URL(input instanceof Request ? input.url : input.toString()),
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
      });
      return new Response(
        JSON.stringify({ Key: "fixture", signedURL: "/fixture" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  const client = createClient(
    "https://storage.example.test",
    "fixture-no-secret",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: createSupabaseFetch("https://storage.example.test", {
          internalUrl: "http://storage-internal:8000",
          fetch: capture,
        }),
      },
    },
  );
  return { client, requests };
}

describe("canonical private Storage boundaries", () => {
  for (const key of INVALID_KEYS) {
    test(`rejects ambiguous key before SDK transport: ${JSON.stringify(key)}`, async () => {
      const { client, requests } = captureClient();
      expect(() => validateVaultKey(key)).toThrow(InvalidStorageKeyError);
      await expect(
        download(client, { bucket: "vault", path: key }),
      ).rejects.toThrow();
      await expect(
        upload(client, {
          bucket: "vault",
          path: key.split("/"),
          file: new File(["fixture"], "invoice.pdf"),
        }),
      ).rejects.toThrow();
      await expect(
        remove(client, { bucket: "vault", path: key.split("/") }),
      ).rejects.toThrow();
      await expect(
        signedUrl(client, { bucket: "vault", path: key, expireIn: 60 }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(0);
    });
  }

  test("valid read and upload remain in the authorized namespace through the actual SDK", async () => {
    const { client, requests } = captureClient();
    const key = `${OWN_TEAM}/invoices/00000000-0000-4000-8000-000000000003.pdf`;
    expect(validateVaultKey(`vault/${key}`).normalizedPath).toBe(key);
    await download(client, { bucket: "vault", path: `vault/${key}` });
    await upload(client, {
      bucket: "vault",
      path: key.split("/"),
      file: new File(["%PDF-fixture"], "invoice.pdf"),
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url.origin).toBe("http://storage-internal:8000");
      expect(request.url.pathname).toContain(`/vault/${OWN_TEAM}/invoices/`);
      expect(request.url.pathname).not.toContain(OTHER_TEAM);
    }
  });

  test("ordinary filenames including spaces and Unicode remain valid", () => {
    const key = `${OWN_TEAM}/documents/Отчет за ноябрь 2026.pdf`;
    expect(validateVaultKey(key).normalizedPath).toBe(key);
  });
});
