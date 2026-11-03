import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  digestDeletedStorageStream,
  readStorageDeletionDigest,
} from "./deletion-proof";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const controller = () => new AbortController();
const bytes = (value: string) => new Uint8Array(Buffer.from(value));
const teamId = "f0087bc0-5834-452d-bf7c-43e405b512cd";
const originalFetch = globalThis.fetch;
const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_INTERNAL_URL",
] as const;
const prior = new Map(names.map((name) => [name, process.env[name]]));
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of prior) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("bounded erased-object proof", () => {
  test("hashes multiple chunks without returning or buffering original content", async () => {
    const stream = new ReadableStream<unknown>({
      start(output) {
        output.enqueue(bytes("original "));
        output.enqueue(bytes("receipt"));
        output.close();
      },
    });
    expect(
      await digestDeletedStorageStream(stream, 16, controller().signal),
    ).toEqual({
      sha256: sha("original receipt"),
      size: 16,
    });
  });

  test("refuses bytes beyond the retained original bound and cancels the source", async () => {
    let cancelled = false;
    const stream = new ReadableStream<unknown>({
      start(output) {
        output.enqueue(bytes("too large"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      digestDeletedStorageStream(stream, 4, controller().signal),
    ).rejects.toThrow("bound");
    expect(cancelled).toBe(true);
  });

  test("an aborted deadline interrupts a stalled stream without inventing a digest", async () => {
    let cancelled = false;
    const stop = controller();
    const stream = new ReadableStream<unknown>({
      cancel() {
        cancelled = true;
      },
    });
    const result = digestDeletedStorageStream(stream, 8, stop.signal);
    stop.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("empty, malformed and out-of-policy evidence is refused", async () => {
    for (const maximum of [0, -1, Number.NaN, 50 * 1024 * 1024 + 1]) {
      await expect(
        digestDeletedStorageStream(
          new ReadableStream(),
          maximum,
          controller().signal,
        ),
      ).rejects.toThrow("bound");
    }
    for (const value of [null, "not bytes"]) {
      const stream = new ReadableStream({
        start(output) {
          output.enqueue(value);
          output.close();
        },
      });
      await expect(
        digestDeletedStorageStream(stream, 10, controller().signal),
      ).rejects.toThrow("chunk");
    }
    const empty = new ReadableStream({
      start(output) {
        output.close();
      },
    });
    await expect(
      digestDeletedStorageStream(empty, 10, controller().signal),
    ).rejects.toThrow("Empty");
  });

  test("the actual SDK capability streams one scoped GET and rejects error bodies before buffering", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_INTERNAL_URL;
    process.env.SUPABASE_URL = "https://storage.example.test";
    process.env.SUPABASE_SECRET_KEY = "fixture-service-role-key";
    let calls = 0;
    let cancelled = false;
    let failed = false;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls++;
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        expect(url.origin).toBe("https://storage.example.test");
        expect(url.pathname).toContain(teamId);
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (failed)
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 503 },
          );
        return new Response(bytes("receipt"), {
          status: 200,
          headers: { "content-length": "7" },
        });
      },
      { preconnect() {} },
    );
    expect(
      await readStorageDeletionDigest(
        { teamId },
        teamId + "/inbox/original.pdf",
        7,
      ),
    ).toEqual({ sha256: sha("receipt"), size: 7 });
    failed = true;
    await expect(
      readStorageDeletionDigest({ teamId }, teamId + "/inbox/original.pdf", 7),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    await expect(
      readStorageDeletionDigest(
        { teamId },
        "a5ae260f-768c-4383-b02c-bf6213f807ca/foreign.pdf",
        7,
      ),
    ).rejects.toThrow("scope");
    expect(calls).toBe(2);
  });
});
