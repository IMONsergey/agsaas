import type { buildReadinessResponse } from "@midday/health/checker";
import { Hono } from "hono";
import type { WorkerPhase } from "./lifecycle";

type ReadinessResponse = ReturnType<typeof buildReadinessResponse>;

export function createWorkerHealthApp(options: {
  getPhase(): WorkerPhase;
  isRuntimeReady(): boolean;
  checkReadiness(): Promise<ReadinessResponse>;
}) {
  const app = new Hono();
  const canReportReady = () =>
    options.getPhase() === "ready" && options.isRuntimeReady();
  const unavailable = () => ({
    status: "degraded" as const,
    checks: { worker: { status: "error", phase: options.getPhase() } },
  });

  app.get("/", (c) => c.json({ status: "ok" }, 200));
  app.get("/health", (c) => c.json({ status: "ok" }, 200));
  app.get("/health/ready", async (c) => {
    if (!canReportReady()) return c.json(unavailable(), 503);
    try {
      const response = await options.checkReadiness();
      // A signal or Redis disconnect can arrive while probes are in flight.
      if (!canReportReady()) return c.json(unavailable(), 503);
      return c.json(response, response.status === "ok" ? 200 : 503);
    } catch {
      return c.json(unavailable(), 503);
    }
  });

  return app;
}
