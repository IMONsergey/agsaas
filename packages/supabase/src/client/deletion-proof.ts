import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertCleanupStoragePaths } from "./cleanup";
import { createSupabaseFetch, withFetchAbortSignal } from "./server-fetch";

const MAX_BYTES = 50 * 1024 * 1024;

function assertBound(maximumBytes: number) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_BYTES
  ) {
    throw new Error("Invalid retained deletion-proof bound");
  }
}

/** Hash a bounded stream in memory without retaining or returning its bytes.
 * Cancellation also interrupts a pending read from a stalled response body. */
export async function digestDeletedStorageStream(
  stream: ReadableStream<unknown>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  assertBound(maximumBytes);
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Invalid storage response chunk");
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        throw new Error("Storage bytes exceed retained deletion-proof bound");
      }
      hash.update(value);
    }
    if (size < 1) throw new Error("Empty storage deletion proof");
    signal.throwIfAborted();
    return { sha256: hash.digest("hex"), size };
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Digest-only server capability, separate from the delete-only cleanup client.
 * The caller supplies one retained team/path and its original maximum size.
 * No object, URL or arbitrary read/list/sign/upload client escapes this function. */
export async function readStorageDeletionDigest(
  scope: { teamId: string },
  path: string,
  maximumBytes: number,
) {
  assertCleanupStoragePaths(scope, "vault", [path]);
  assertBound(maximumBytes);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Storage deletion proof is not configured");
  const deadline = AbortSignal.timeout(10_000);
  const transport = withFetchAbortSignal(
    createSupabaseFetch(url),
    () => deadline,
  );
  const boundedFetch = Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const response = await transport(input, { ...init, redirect: "error" });
      const length = response.headers.get("content-length");
      if (
        response.status !== 200 ||
        (length !== null &&
          (!/^\d+$/.test(length) || Number(length) > maximumBytes))
      ) {
        // Do not let the SDK buffer an unbounded provider error response either.
        void response.body?.cancel().catch(() => {});
        throw new Error(
          "Storage deletion proof is unavailable or exceeds its bound",
        );
      }
      return response;
    },
    {
      preconnect: (
        target: Parameters<typeof globalThis.fetch.preconnect>[0],
        options?: Parameters<typeof globalThis.fetch.preconnect>[1],
      ) => transport.preconnect?.(target, options),
    },
  );
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: boundedFetch },
  });
  // The installed Storage SDK exposes asStream(); awaiting download() directly
  // would materialize an unbounded Blob before a size check.
  const { data, error } = await client.storage
    .from("vault")
    .download(path)
    .asStream();
  if (error || !data) throw new Error("Storage deletion proof is unavailable");
  return digestDeletedStorageStream(data, maximumBytes, deadline);
}
