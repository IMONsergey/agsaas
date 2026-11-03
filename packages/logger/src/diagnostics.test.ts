import { describe, expect, test } from "bun:test";
import type pino from "pino";
import { diagnosticSummary, sanitizeTelemetryEvent } from "./diagnostics";
import { createLoggerAdapter } from "./index";

const privateValue = "fixture-private-data-12345";
const id = "00000000-0000-4000-8000-000000000001";

describe("diagnostics expose operational metadata only", () => {
  test("request/job payloads, errors and nested credentials never enter the actual logger sink", () => {
    const captured: unknown[][] = [];
    const sink = {
      info: (...args: unknown[]) => captured.push(args),
      error: (...args: unknown[]) => captured.push(args),
      warn: (...args: unknown[]) => captured.push(args),
      debug: (...args: unknown[]) => captured.push(args),
    } as unknown as pino.Logger;
    const logger = createLoggerAdapter(sink);
    logger.error("Job failed", {
      jobId: id,
      attempt: 2,
      payload: { accessToken: privateValue },
      invalidTransactions: [{ description: privateValue, amount: 100 }],
      error: privateValue,
      errorDetails: {
        detail: privateValue,
        cause: { message: privateValue },
        code: "23505",
      },
    });
    const output = JSON.stringify(captured);
    expect(output).not.toContain(privateValue);
    expect(output).toContain(id);
    expect(output).toContain("23505");
    expect(output).toContain("attempt");
  });
  test("telemetry strips request body, auth/cookies, user PII, raw exception values, locals and breadcrumbs", () => {
    const event = {
      event_id: id,
      level: "error",
      request: {
        headers: { Authorization: privateValue },
        data: privateValue,
        query_string: privateValue,
      },
      user: { email: privateValue },
      breadcrumbs: [{ message: privateValue }],
      extra: {
        payload: privateValue,
        input: privateValue,
        diagnostics: { teamId: id, token: privateValue, count: 3 },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: privateValue,
            stacktrace: {
              frames: [
                {
                  filename: "worker.ts",
                  lineno: 42,
                  vars: { secret: privateValue },
                  context_line: privateValue,
                },
              ],
            },
          },
        ],
      },
    };
    const result = sanitizeTelemetryEvent(event);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(result.extra.diagnostics.teamId).toBe(id);
    expect(result.exception.values[0]?.stacktrace.frames[0]?.filename).toBe(
      "worker.ts",
    );
    expect(result.exception.values[0]?.stacktrace.frames[0]?.lineno).toBe(42);
    expect(event.request.data).toBe(privateValue);
  });
  test("unknown arbitrary fields and financial values are omitted", () => {
    expect(
      diagnosticSummary({
        unknownField: privateValue,
        amount: 999,
        balance: 42,
        email: privateValue,
        secret: privateValue,
        invalidCount: 4,
        retryable: false,
      }),
    ).toEqual({ invalidCount: 4, retryable: false });
  });
});
