/** Operational telemetry is an allowlist, never a copy of request/job data. */
const names = new Set([
  "jobName",
  "queue",
  "source",
  "procedurePath",
  "provider",
  "providerId",
  "errorCategory",
  "category",
  "code",
  "errorType",
  "status",
  "method",
  "resultType",
  "syscall",
  "severity",
  "constraint",
]);
const ids = new Set([
  "jobId",
  "teamId",
  "userId",
  "invoiceId",
  "inboxId",
  "connectionId",
  "cleanupId",
  "operationId",
  "customerId",
  "documentId",
  "dispatchId",
  "requestId",
  "trace_id",
  "span_id",
  "parent_span_id",
]);
const numbers = new Set([
  "attempt",
  "maxAttempts",
  "remainingAttempts",
  "duration",
  "elapsed",
  "progress",
  "count",
  "port",
  "errno",
  "totalItems",
  "totalMs",
  "durationMs",
  "suggestedRetryDelay",
  "suggestedMaxRetries",
  "sizeMB",
]);
const nested = new Set(["diagnostics", "errorDetails", "pool", "stats"]);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function redactDiagnosticMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:mid_access_token_|mid_|sk_live_|sk_test_|rk_live_|rk_test_)[a-zA-Z0-9_-]+\b/g,
      "[redacted]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/https?:\/\/[^\s)]+/g, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .slice(0, 1000);
}
export function diagnosticSummary(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = record(value);
  for (const [key, item] of Object.entries(source)) {
    if (
      names.has(key) &&
      typeof item === "string" &&
      /^[a-zA-Z0-9_.:/ -]{1,100}$/.test(item)
    ) {
      out[key] = redactDiagnosticMessage(item);
    } else if (
      ids.has(key) &&
      typeof item === "string" &&
      (/^[0-9a-f-]{16,64}$/i.test(item) || /^\d{1,16}$/.test(item))
    ) {
      out[key] = item;
    } else if (
      (numbers.has(key) || /(?:Count|Ms)$/.test(key)) &&
      typeof item === "number" &&
      Number.isFinite(item)
    ) {
      out[key] = item;
    } else if (
      numbers.has(key) &&
      typeof item === "string" &&
      /^\d+(?:\.\d+)?(?:ms)?$/.test(item)
    ) {
      out[key] = item;
    } else if (
      typeof item === "boolean" &&
      !/(token|secret|password|credential)/i.test(key) &&
      /^[a-zA-Z]{1,40}$/.test(key)
    ) {
      out[key] = item;
    } else if (nested.has(key) && depth < 2) {
      out[key] = diagnosticSummary(item, depth + 1);
    }
  }
  return out;
}

function safeFrame(value: unknown) {
  const frame = record(value);
  const out: Record<string, unknown> = {};
  for (const key of ["filename", "function", "module"]) {
    if (typeof frame[key] === "string")
      out[key] = redactDiagnosticMessage(frame[key]).split("?")[0];
  }
  for (const key of ["lineno", "colno", "in_app"]) {
    if (typeof frame[key] === "number" || typeof frame[key] === "boolean")
      out[key] = frame[key];
  }
  return out;
}
/** No request/headers/cookies, raw error values, breadcrumbs, locals or payloads. */
export function sanitizeTelemetryEvent<T extends object>(event: T): T {
  const source = record(event);
  const out: Record<string, unknown> = {};
  for (const key of [
    "event_id",
    "type",
    "level",
    "platform",
    "release",
    "environment",
    "logger",
  ]) {
    if (typeof source[key] === "string")
      out[key] = redactDiagnosticMessage(source[key]);
  }
  for (const key of ["timestamp", "start_timestamp"])
    if (typeof source[key] === "number") out[key] = source[key];
  if (typeof source.transaction === "string")
    out.transaction = redactDiagnosticMessage(source.transaction).split("?")[0];
  if (typeof source.message === "string")
    out.message = "Application diagnostic event";
  out.tags = diagnosticSummary(source.tags);
  out.extra = diagnosticSummary(source.extra);
  const exception = record(source.exception);
  if (Array.isArray(exception.values)) {
    out.exception = {
      values: exception.values.map((value) => {
        const item = record(value);
        const stack = record(item.stacktrace);
        return {
          type:
            typeof item.type === "string" &&
            /^[a-zA-Z0-9_.]{1,80}$/.test(item.type)
              ? item.type
              : "Error",
          value: "Error details redacted",
          stacktrace: {
            frames: Array.isArray(stack.frames)
              ? stack.frames.map(safeFrame)
              : [],
          },
        };
      }),
    };
  }
  const trace = record(record(source.contexts).trace);
  if (Object.keys(trace).length)
    out.contexts = { trace: diagnosticSummary(trace) };
  if (Array.isArray(source.spans))
    out.spans = source.spans.map((span) => {
      const item = record(span);
      const result = diagnosticSummary(item);
      for (const key of ["timestamp", "start_timestamp"])
        if (typeof item[key] === "number") result[key] = item[key];
      return result;
    });
  return out as T;
}
