import { describe, expect, mock, test } from "bun:test";
import type { DependencyResult } from "@midday/health/registry";
import { getApiReadiness } from "../../utils/readiness";

const healthy: DependencyResult = {
  name: "database",
  tier: 1,
  healthy: true,
  latencyMs: 3,
  lastChecked: "2026-01-01T00:00:00.000Z",
};

describe("API readiness during shutdown", () => {
  test("preserves normal core dependency results", async () => {
    const check = mock(async () => [healthy]);
    expect(
      await getApiReadiness({ isShuttingDown: () => false, check }),
    ).toEqual({
      status: "ok",
      checks: { database: { status: "ok", latencyMs: 3 } },
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("does not hide a failed core dependency", async () => {
    const response = await getApiReadiness({
      isShuttingDown: () => false,
      check: async () => [
        { ...healthy, healthy: false, error: "database unavailable" },
      ],
    });
    expect(response.status).toBe("degraded");
    expect(response.checks).toEqual({
      database: {
        status: "error",
        latencyMs: 3,
        error: "database unavailable",
      },
    });
  });

  test("shutdown reports unready without probing closing dependencies", async () => {
    const check = mock(async () => [healthy]);
    const response = await getApiReadiness({
      isShuttingDown: () => true,
      check,
    });
    expect(response.status).toBe("degraded");
    expect(response.checks).toHaveProperty("shutdown.status", "error");
    expect(check).not.toHaveBeenCalled();
  });

  test("an already-running probe cannot report ready after shutdown begins", async () => {
    let shuttingDown = false;
    const response = await getApiReadiness({
      isShuttingDown: () => shuttingDown,
      check: async () => {
        shuttingDown = true;
        return [healthy];
      },
    });
    expect(response.status).toBe("degraded");
    expect(response.checks).toHaveProperty("shutdown.status", "error");
    expect(response.checks).not.toHaveProperty("database");
  });
});
