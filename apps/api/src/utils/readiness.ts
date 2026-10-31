import { buildReadinessResponse } from "@midday/health/checker";
import type { DependencyResult } from "@midday/health/registry";

export async function getApiReadiness(options: {
  isShuttingDown: () => boolean;
  check: () => Promise<DependencyResult[]>;
}) {
  if (!options.isShuttingDown()) {
    const results = await options.check();
    // A request started before SIGTERM can finish its probes after shutdown.
    if (!options.isShuttingDown()) return buildReadinessResponse(results);
  }

  return {
    status: "degraded" as const,
    checks: {
      shutdown: {
        status: "error",
        latencyMs: 0,
        error: "API is shutting down",
      },
    },
  };
}
