import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HttpRequest, Upload } from "tus-js-client";

type Options = ConstructorParameters<typeof Upload>[1];
type Previous = Awaited<ReturnType<Upload["findPreviousUploads"]>>[number];
const team = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
let options: Options;
let previous: Previous[] = [];
let resumed: Previous | undefined;
let failure: Error | undefined;
let created = 0;
let started = 0;
let session: { user: { id: string }; access_token: string } | null;
let sessionReads = 0;
mock.module("tus-js-client", () => ({
  Upload: class {
    constructor(_file: File, value: Options) {
      options = value;
      created++;
    }
    async findPreviousUploads() {
      if (failure) throw failure;
      return previous;
    }
    resumeFromPreviousUpload(value: Previous) {
      resumed = value;
    }
    start() {
      started++;
      queueMicrotask(() =>
        options.onSuccess?.({
          lastResponse: {
            getStatus: () => 201,
            getHeader: () => undefined,
            getBody: () => "",
            getUnderlyingObject: () => null,
          },
        }),
      );
    }
  },
}));
const { prepareVaultUploads, resumableEndpoint, resumableUpload } =
  await import("./upload");
const original = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL =
    "https://storage.agsaas.example.test:8549";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fixture_public_key";
  session = { user: { id: user }, access_token: "fixture_access_token" };
  previous = [];
  resumed = undefined;
  failure = undefined;
  created = 0;
  started = 0;
  sessionReads = 0;
});
afterAll(() => {
  for (const [key, value] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: original.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: original.key,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const client = {
  auth: {
    getSession: async () => {
      sessionReads++;
      return { data: { session }, error: null };
    },
  },
} as unknown as SupabaseClient;
const file = () =>
  new File(["synthetic receipt"], "Receipt 1.pdf", {
    type: "application/pdf",
    lastModified: 1000,
  });
const plan = () => prepareVaultUploads([file()], [team, "inbox"])[0]!;
async function upload() {
  return resumableUpload(client, { ...plan(), bucket: "vault" });
}
function request(url: string): HttpRequest {
  const headers = new Map<string, string>();
  return {
    getMethod: () => "PATCH",
    getURL: () => url,
    setHeader: (key, value) => {
      headers.set(key, value);
    },
    getHeader: (key) => headers.get(key),
    setProgressHandler: () => {},
    send: async () => {
      throw new Error("Network forbidden");
    },
    abort: async () => {},
    getUnderlyingObject: () => null,
  };
}
describe("own resumable document uploads", () => {
  test("same-named files get distinct immutable object identities before DB registration", () => {
    const plans = prepareVaultUploads([file(), file()], [team, "inbox"]);
    expect(plans[0]!.filePath).not.toEqual(plans[1]!.filePath);
    expect(
      plans.every((p) => p.filePath[0] === team && p.filePath[1] === "inbox"),
    ).toBe(true);
    expect(plans[0]!.displayName).toBe("Receipt 1.pdf");
    expect(plans[0]!.filename).toBe("receipt-1.pdf");
    expect(plans[0]!.filePath).toEqual([...plans[0]!.path, plans[0]!.filename]);
  });
  test("rejects missing/encoded team paths and oversized picker batches before creating a transport", () => {
    for (const path of [[], ["missing"], [team, ".."], [team, "%2f"]])
      expect(() => prepareVaultUploads([file()], path)).toThrow();
    expect(() =>
      prepareVaultUploads(Array.from({ length: 26 }, file), [team]),
    ).toThrow("25");
    expect(() =>
      prepareVaultUploads(
        [new File([new Uint8Array(5_000_001)], "large.pdf")],
        [team],
      ),
    ).toThrow("5 MB");
    expect(created).toBe(0);
  });
  test("uses the configured own origin and preserves the registered canonical path without upsert", async () => {
    const prepared = plan();
    const result = await resumableUpload(client, {
      ...prepared,
      bucket: "vault",
    });
    expect(options.endpoint).toBe(
      "https://storage.agsaas.example.test:8549/storage/v1/upload/resumable",
    );
    expect(options.headers?.["x-upsert"]).toBeUndefined();
    expect(options.headers?.apikey).toBe("fixture_public_key");
    expect(options.metadata?.objectName).toBe(prepared.filePath.join("/"));
    expect(result.filePath).toEqual(prepared.filePath);
    expect(result.file).toBe(prepared.file);
  });
  test("refuses an upstream, insecure or credential-bearing configured origin", () => {
    for (const value of [
      "https://old.midday.ai",
      "http://remote.example.test",
      "https://user:password@own.example.test",
      "https://own.example.test/path",
    ])
      expect(() => resumableEndpoint(value)).toThrow();
    expect(resumableEndpoint("http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321/storage/v1/upload/resumable",
    );
  });
  test("does not start an unauthenticated upload", async () => {
    session = null;
    await expect(upload()).rejects.toThrow("Sign in");
    expect(created).toBe(0);
  });
  test("propagates resume-storage rejection instead of leaving a pending promise", async () => {
    failure = new Error("Browser upload storage unavailable");
    await expect(upload()).rejects.toThrow(
      "Browser upload storage unavailable",
    );
    expect(started).toBe(0);
  });
  test("resumes only the exact own object, never another origin or file metadata", async () => {
    const prepared = plan();
    const endpoint = resumableEndpoint();
    const base: Previous = {
      size: prepared.file.size,
      metadata: {
        bucketName: "vault",
        objectName: prepared.filePath.join("/"),
      },
      creationTime: new Date().toISOString(),
      urlStorageKey: "fixture",
      uploadUrl: endpoint + "/own-id",
      parallelUploadUrls: null,
    };
    previous = [
      {
        ...base,
        uploadUrl:
          "https://foreign.example.test/storage/v1/upload/resumable/stolen",
      },
      {
        ...base,
        metadata: { ...base.metadata, objectName: team + "/different.pdf" },
      },
      base,
    ];
    await resumableUpload(client, { ...prepared, bucket: "vault" });
    expect(resumed).toBe(base);
  });
  test("fingerprints bind storage, identity, workspace and immutable object path", async () => {
    const prepared = plan();
    await resumableUpload(client, { ...prepared, bucket: "vault" });
    const original = await options.fingerprint!(prepared.file, options);
    await resumableUpload(client, { ...plan(), bucket: "vault" });
    expect(await options.fingerprint!(prepared.file, options)).not.toBe(
      original,
    );
    session = {
      user: { id: "33333333-3333-4333-8333-333333333333" },
      access_token: "other_fixture",
    };
    await resumableUpload(client, { ...prepared, bucket: "vault" });
    expect(await options.fingerprint!(prepared.file, options)).not.toBe(
      original,
    );
    expect(original).not.toContain("fixture_access_token");
  });
  test("refreshes the credential before a chunk and refuses identity changes", async () => {
    await upload();
    session!.access_token = "refreshed_fixture";
    const req = request(resumableEndpoint() + "/exact-upload");
    await options.onBeforeRequest!(req);
    expect(req.getHeader("authorization")).toBe("Bearer refreshed_fixture");
    session!.user.id = "33333333-3333-4333-8333-333333333333";
    await expect(
      Promise.resolve(options.onBeforeRequest!(req)),
    ).rejects.toThrow("account changed");
  });
  test.each([
    "https://foreign.example.test/storage/v1/upload/resumable/id",
    "https://storage.agsaas.example.test:8549/storage/v1/object/private",
    "https://storage.agsaas.example.test:8549/storage/v1/upload/resumable/../private",
    "https://storage.agsaas.example.test:8549/storage/v1/upload/resumable/id?redirect=elsewhere",
  ])("never forwards fresh credentials to an unexpected upload destination: %s", async (url) => {
    await upload();
    const before = sessionReads;
    const req = request(url);
    await expect(
      Promise.resolve(options.onBeforeRequest!(req)),
    ).rejects.toThrow("endpoint changed");
    expect(sessionReads).toBe(before);
    expect(req.getHeader("authorization")).toBeUndefined();
  });
});
