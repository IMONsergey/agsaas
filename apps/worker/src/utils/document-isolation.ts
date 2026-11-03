import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MAX_DOCUMENT_INPUT_BYTES } from "./document-limits";
import type { DocumentTask, DocumentTaskResult } from "./document-task-types";
import { TimeoutError } from "./timeout";

export { MAX_DOCUMENT_INPUT_BYTES } from "./document-limits";
export const MAX_DOCUMENT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_BYTES = 36 * 1024 * 1024;
const defaultEntrypoint = new URL(
  "./document-isolation-child.ts",
  import.meta.url,
);
let active = 0;
const children = new Set<ReturnType<typeof spawn>>();
const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shutdown.abort(
      new Error("Document processing interrupted by worker shutdown"),
    );
    for (const child of children) child.kill("SIGKILL");
  });
}
function childEnvironment(kind: DocumentTask["kind"]) {
  const result: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    TZ: "UTC",
    LANG: "C.UTF-8",
  };
  // Parsing never receives service-role, SQL, Redis, email or payment credentials.
  if (
    ["classify-document", "classify-image", "embed-tags", "extract"].includes(
      kind,
    )
  ) {
    for (const key of ["GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY"])
      if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}
export function documentInputBase64(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Document processing accepts files up to 25 MiB");
  return Buffer.from(bytes).toString("base64");
}
/** One read-only process per task; killing and joining it precedes every timeout rejection. */
export async function runDocumentTask<T extends DocumentTask>(
  task: T,
  options: { timeoutMs?: number; signal?: AbortSignal; entrypoint?: URL } = {},
): Promise<DocumentTaskResult<T>> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (timeoutMs <= 0 || timeoutMs > 600_000)
    throw new Error("Invalid isolated document deadline");
  shutdown.signal.throwIfAborted();
  options.signal?.throwIfAborted();
  if (active >= 2)
    throw new Error("Document processor is busy; retry this operation");
  const id = randomUUID();
  const request = JSON.stringify({ id, task });
  if (Buffer.byteLength(request) > MAX_WIRE_BYTES)
    throw new Error("Document processing request is too large");
  active++;
  try {
    return await new Promise<DocumentTaskResult<T>>((resolve, reject) => {
      let settled = false,
        outputSize = 0,
        terminalError: Error | undefined;
      const chunks: Buffer[] = [];
      const child = spawn(
        process.execPath,
        [
          "--no-env-file",
          fileURLToPath(options.entrypoint ?? defaultEntrypoint),
        ],
        {
          env: childEnvironment(task.kind),
          stdio: ["pipe", "ignore", "ignore", "pipe"],
        },
      );
      children.add(child);
      const signal = options.signal
        ? AbortSignal.any([options.signal, shutdown.signal])
        : shutdown.signal;
      const kill = (error: Error) => {
        terminalError ??= error;
        child.kill("SIGKILL");
      };
      const onAbort = () =>
        kill(new Error("Document processing was cancelled before publication"));
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () =>
          kill(
            new TimeoutError(
              "Document processing deadline exceeded; isolated process terminated",
              timeoutMs,
            ),
          ),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        children.delete(child);
      };
      child.once("error", (error) => {
        terminalError ??= error;
        // A failed spawn has no process to join.
        if (!child.pid && !settled) {
          settled = true;
          cleanup();
          reject(new Error("Document processor could not start"));
        }
      });
      const responseStream = child.stdio[3] as import("node:stream").Readable;
      responseStream.on("data", (chunk: Buffer) => {
        outputSize += chunk.length;
        if (outputSize > MAX_DOCUMENT_OUTPUT_BYTES) {
          kill(new Error("Document result exceeds the processing limit"));
          return;
        }
        if (!terminalError) chunks.push(chunk);
      });
      child.stdin?.on("error", () => {
        /* close reports the process outcome */
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminalError) {
          reject(terminalError);
          return;
        }
        if (code !== 0) {
          reject(
            new Error("Document processing failed; original file is preserved"),
          );
          return;
        }
        try {
          const payload = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as { id?: string; ok?: boolean; result?: DocumentTaskResult<T> };
          if (payload.id !== id || payload.ok !== true)
            throw new Error("Invalid document result");
          resolve(payload.result as DocumentTaskResult<T>);
        } catch {
          reject(new Error("Document processor returned an invalid result"));
        }
      });
      child.stdin?.end(request);
      if (signal.aborted) onAbort();
    });
  } finally {
    active--;
  }
}
