import { describe, expect, mock, test } from "bun:test";
import { createWorkerHealthApp } from "./health";
import type { WorkerPhase } from "./lifecycle";

const healthy = {
  status: "ok" as const,
  checks: { database: { status: "ok", latencyMs: 1 } },
};

describe("worker readiness", () => {
  test.each([
    "starting",
    "draining",
    "stopped",
  ] as const)("does not probe or report ready while %s", async (phase) => {
    const checkReadiness = mock(async () => healthy);
    const app = createWorkerHealthApp({
      getPhase: () => phase,
      isRuntimeReady: () => true,
      checkReadiness,
    });
    expect((await app.request("/health/ready")).status).toBe(503);
    expect(checkReadiness).not.toHaveBeenCalled();
    expect((await app.request("/health")).status).toBe(200);
    expect(await (await app.request("/")).json()).toEqual({ status: "ok" });
  });

  test("preserves the healthy response shape after startup", async () => {
    const app = createWorkerHealthApp({
      getPhase: () => "ready",
      isRuntimeReady: () => true,
      checkReadiness: async () => healthy,
    });
    const response = await app.request("/health/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthy);
  });

  test("connection loss overrides a cached healthy dependency result", async () => {
    let connected = true;
    const checkReadiness = mock(async () => healthy);
    const app = createWorkerHealthApp({
      getPhase: () => "ready",
      isRuntimeReady: () => connected,
      checkReadiness,
    });
    expect((await app.request("/health/ready")).status).toBe(200);
    connected = false;
    expect((await app.request("/health/ready")).status).toBe(503);
    expect(checkReadiness).toHaveBeenCalledTimes(1);
    connected = true;
    expect((await app.request("/health/ready")).status).toBe(200);
  });

  test("an in-flight healthy probe cannot turn a draining worker ready", async () => {
    let phase: WorkerPhase = "ready";
    let complete!: () => void;
    let entered!: () => void;
    const inProbe = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const app = createWorkerHealthApp({
      getPhase: () => phase,
      isRuntimeReady: () => true,
      checkReadiness: async () => {
        entered();
        await pending;
        return healthy;
      },
    });
    const response = app.request("/health/ready");
    await inProbe;
    phase = "draining";
    complete();
    expect((await response).status).toBe(503);
  });

  test("dependency failures and thrown probe errors return 503", async () => {
    const degraded = createWorkerHealthApp({
      getPhase: () => "ready",
      isRuntimeReady: () => true,
      checkReadiness: async () => ({ ...healthy, status: "degraded" }),
    });
    expect((await degraded.request("/health/ready")).status).toBe(503);
    const broken = createWorkerHealthApp({
      getPhase: () => "ready",
      isRuntimeReady: () => true,
      checkReadiness: async () => {
        throw new Error("private connection details");
      },
    });
    const response = await broken.request("/health/ready");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private connection details");
  });
});
