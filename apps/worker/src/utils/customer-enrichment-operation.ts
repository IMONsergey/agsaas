type Result = { verified: Record<string, unknown>; verifiedFieldCount: number };
type Dependencies<T extends Result> = {
  enrich: (signal: AbortSignal) => Promise<T>;
  isCurrent: () => Promise<boolean>;
  complete: (result: T) => Promise<boolean>;
  fail: (code: "timeout" | "provider_error") => Promise<unknown>;
};
export async function executeCustomerEnrichment<T extends Result>(
  dependencies: Dependencies<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  const controller = new AbortController();
  let deadlineReached = false;
  const timeout = setTimeout(() => {
    deadlineReached = true;
    controller.abort(
      new DOMException("Enrichment deadline reached", "TimeoutError"),
    );
  }, options.timeoutMs ?? 30_000);
  let checking = false;
  const poll = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    dependencies
      .isCurrent()
      .then((active) => {
        if (!active)
          controller.abort(
            new DOMException(
              "Enrichment cancelled or superseded",
              "AbortError",
            ),
          );
      })
      .catch(() =>
        controller.abort(
          new DOMException("Enrichment authority unavailable", "AbortError"),
        ),
      )
      .finally(() => {
        checking = false;
      });
  }, options.pollMs ?? 1_000);
  try {
    const result = await dependencies.enrich(controller.signal);
    const active = await dependencies.isCurrent();
    if (!active) return { status: "superseded" as const };
    if (controller.signal.aborted) {
      if (deadlineReached) {
        await dependencies.fail("timeout");
        return { status: "failed" as const };
      }
      return { status: "superseded" as const };
    }
    return (await dependencies.complete(result))
      ? {
          status: "enriched" as const,
          fieldsEnriched: result.verifiedFieldCount,
        }
      : { status: "superseded" as const };
  } catch (error) {
    if (!(await dependencies.isCurrent().catch(() => false)))
      return { status: "superseded" as const };
    await dependencies.fail(
      deadlineReached ||
        (error instanceof Error && error.name === "TimeoutError")
        ? "timeout"
        : "provider_error",
    );
    return { status: "failed" as const };
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
  }
}
