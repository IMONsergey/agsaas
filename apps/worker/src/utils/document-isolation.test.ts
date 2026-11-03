import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOperationSignal } from "@midday/utils/operation-context";
import { documentInputBase64, runDocumentTask } from "./document-isolation";
import { TimeoutError } from "./timeout";

const entrypoint = new URL(
  "./fixtures/document-isolation-fixture.ts",
  import.meta.url,
);
describe("isolated document lifetime", () => {
  it("joins a killed child before retry and suppresses its delayed write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agsaas-document-"));
    const marker = join(dir, "late.txt");
    try {
      await expect(
        runDocumentTask(
          { kind: "classify-document", content: "late:" + marker },
          { entrypoint, timeoutMs: 500 },
        ),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(
        await runDocumentTask(
          { kind: "classify-document", content: "ok" },
          { entrypoint, timeoutMs: 3000 },
        ),
      ).toEqual({ title: "fixture" });
      expect(existsSync(marker + ".ready")).toBe(true);
      await Bun.sleep(1100);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("terminates a CPU loop after it actually starts and keeps the parent responsive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agsaas-cpu-"));
    const marker = join(dir, "ready");
    const started = Date.now();
    try {
      await expect(
        runDocumentTask(
          { kind: "classify-document", content: "busy:" + marker },
          { entrypoint, timeoutMs: 500 },
        ),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(existsSync(marker)).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects excessive inputs before spawning", () => {
    expect(() =>
      documentInputBase64(new Uint8Array(25 * 1024 * 1024 + 1)),
    ).toThrow("25 MiB");
  });
  it("kills a cancelled task and frees the worker slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agsaas-cancel-"));
    const marker = join(dir, "ready");
    const controller = new AbortController();
    try {
      const run = runDocumentTask(
        { kind: "classify-document", content: "busy:" + marker },
        { entrypoint, timeoutMs: 3000, signal: controller.signal },
      );
      const assertion = expect(run).rejects.toThrow("cancelled");
      for (let tries = 0; tries < 100 && !existsSync(marker); tries++)
        await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      controller.abort();
      await assertion;
      expect(
        await runDocumentTask(
          { kind: "classify-document", content: "ok" },
          { entrypoint, timeoutMs: 3000 },
        ),
      ).toEqual({ title: "fixture" });
    } finally {
      controller.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("uses the real parser to read local text without provider credentials", async () => {
    expect(
      await runDocumentTask(
        {
          kind: "parse",
          base64: Buffer.from("Synthetic document").toString("base64"),
          mimetype: "text/plain",
        },
        { timeoutMs: 10000 },
      ),
    ).toBe("Synthetic document");
  });
  it("rejects an already cancelled parent context before starting a process", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Parent task cancelled"));
    await expect(
      withOperationSignal(controller.signal, () =>
        runDocumentTask(
          { kind: "classify-document", content: "ok" },
          { entrypoint },
        ),
      ),
    ).rejects.toThrow("Parent task cancelled");
  });
});
