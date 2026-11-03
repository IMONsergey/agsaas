import { describe, expect, test } from "bun:test";
import {
  InvalidStorageKeyError,
  requireVaultPathForTeam,
} from "@midday/utils/storage-path";
import { createClient } from "@supabase/supabase-js";
import { withTeamStorage } from "./team-storage";

const TEAM = "00000000-0000-4000-8000-000000000001";
const FOREIGN = "00000000-0000-4000-8000-000000000002";
const own = `${TEAM}/inbox/Receipt November.pdf`;
const foreign = `${FOREIGN}/inbox/private.pdf`;

function fixture() {
  const calls: string[] = [];
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return new Response(
        JSON.stringify({ Key: "fixture", signedURL: "/fixture" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    { preconnect() {} },
  ) as typeof fetch;
  const sdk = createClient(
    "https://storage.example.test",
    "fixture-no-secret",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: transport },
    },
  );
  return { client: withTeamStorage(sdk, TEAM), calls };
}

describe("elevated Storage client is bound to a team", () => {
  const invalid = [
    foreign,
    `${TEAM}/../${FOREIGN}/private.pdf`,
    `${TEAM}/%2e%2e/private.pdf`,
    `${TEAM}/%252e%252e/private.pdf`,
    `${TEAM}//private.pdf`,
    `${TEAM}/./private.pdf`,
    `${TEAM}/bad?query`,
    `${TEAM}/bad#fragment`,
    `${TEAM}/bad\\path`,
    `${TEAM}/bad\u0000name`,
    `/${TEAM}/private.pdf`,
  ];
  for (const path of invalid) {
    test(`blocks foreign or ambiguous paths before the real SDK transport: ${JSON.stringify(path)}`, async () => {
      const { client, calls } = fixture();
      const bucket = client.storage.from("vault");
      const operations: Array<() => unknown> = [
        () => bucket.download(path),
        () => bucket.upload(path, new Blob(["fixture"])),
        () => bucket.update(path, new Blob(["fixture"])),
        () => bucket.createSignedUrl(path, 60),
        () => bucket.remove([own, path]),
        () => bucket.createSignedUrls([own, path], 60),
        () => bucket.move(own, path),
        () => bucket.copy(path, own),
      ];
      for (const operation of operations) {
        await expect(Promise.resolve().then(operation)).rejects.toThrow(
          InvalidStorageKeyError,
        );
      }
      expect(calls).toHaveLength(0);
    });
  }
  test("valid read/write/sign use the caller's namespace through the actual SDK", async () => {
    const { client, calls } = fixture();
    const bucket = client.storage.from("vault");
    await bucket.download(own);
    await bucket.upload(own, new Blob(["fixture"]));
    await bucket.createSignedUrl(own, 60);
    expect(calls).toHaveLength(3);
    for (const url of calls) {
      expect(new URL(url).pathname).toContain(`/vault/${TEAM}/inbox/`);
      expect(url).not.toContain(FOREIGN);
    }
  });
  test("listing, bucket selection and moves cannot widen the capability", () => {
    const { client, calls } = fixture();
    expect(() => client.storage.from("public")).toThrow(InvalidStorageKeyError);
    expect(() => client.storage.from("vault").list()).toThrow(
      InvalidStorageKeyError,
    );
    expect(() => client.storage.from("vault").list(FOREIGN)).toThrow(
      InvalidStorageKeyError,
    );
    expect(() =>
      client.storage
        .from("vault")
        .copy(own, own, { destinationBucket: "public" }),
    ).toThrow(InvalidStorageKeyError);
    expect(() => client.storage.listBuckets()).toThrow(InvalidStorageKeyError);
    expect(calls).toHaveLength(0);
  });
  test("new SDK methods fail closed instead of inheriting the service key", () => {
    let calls = 0;
    const client = withTeamStorage(
      {
        storage: {
          from: (_bucket: string) => ({ futureMethod: () => calls++ }),
        },
      },
      TEAM,
    );
    expect(() => client.storage.from("vault").futureMethod()).toThrow(
      InvalidStorageKeyError,
    );
    expect(calls).toBe(0);
  });
  test("array segments are canonical identifiers, not paths to normalize", () => {
    expect(
      requireVaultPathForTeam([TEAM, "inbox", "Отчет.pdf"], TEAM).pathTeamId,
    ).toBe(TEAM);
    expect(() =>
      requireVaultPathForTeam([`${TEAM}/inbox`, "receipt.pdf"], TEAM),
    ).toThrow(InvalidStorageKeyError);
    expect(() =>
      requireVaultPathForTeam([FOREIGN, "receipt.pdf"], TEAM),
    ).toThrow(InvalidStorageKeyError);
    expect(() =>
      requireVaultPathForTeam([TEAM, "receipt.pdf"], "not-a-team"),
    ).toThrow(InvalidStorageKeyError);
  });
});
