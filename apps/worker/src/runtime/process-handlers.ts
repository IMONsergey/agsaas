import type { WorkerLifecycle } from "./lifecycle";

/** Register only on the owning worker process, never at module import time. */
export function installWorkerProcessHandlers(
  lifecycle: WorkerLifecycle,
  reportFatal: (
    event: "uncaughtException" | "unhandledRejection",
    error: unknown,
  ) => void,
  target: NodeJS.Process = process,
): () => void {
  const onTerm = () => {
    void lifecycle.shutdown("SIGTERM");
  };
  const onInterrupt = () => {
    void lifecycle.shutdown("SIGINT");
  };
  const fatal = (
    event: "uncaughtException" | "unhandledRejection",
    error: unknown,
  ) => {
    try {
      reportFatal(event, error);
    } catch {
      // Preserve the shutdown path even if telemetry itself throws.
    }
    void lifecycle.shutdown(event, 1);
  };
  const onException = (error: Error) => fatal("uncaughtException", error);
  const onRejection = (reason: unknown) => fatal("unhandledRejection", reason);

  target.on("SIGTERM", onTerm);
  target.on("SIGINT", onInterrupt);
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);

  return () => {
    target.off("SIGTERM", onTerm);
    target.off("SIGINT", onInterrupt);
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}
