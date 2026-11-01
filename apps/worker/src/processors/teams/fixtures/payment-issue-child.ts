import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import type { Job } from "bullmq";
import type { PaymentIssuePayload } from "../../../schemas/teams";

const scenario = process.argv[2];
let fetchAttempts = 0;
let networkAttempts = 0;
const requests: Array<Record<string, unknown>> = [];
const rows = new Map<string, any>();
const blockNetwork = (kind: string): never => {
  networkAttempts++;
  throw new Error(`NETWORK_FORBIDDEN:${kind}`);
};
Socket.prototype.connect = () => blockNetwork("socket");
Bun.connect = () => blockNetwork("Bun.connect");
Bun.serve = () => blockNetwork("Bun.serve");
globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    fetchAttempts++;
    if (
      String(input) !== "https://api.resend.com/emails/batch" ||
      typeof init?.body !== "string"
    )
      return blockNetwork("fetch");
    const payload = JSON.parse(init.body) as Array<Record<string, unknown>>;
    requests.push(...payload);
    if (scenario === "send-error")
      throw new Error("fixture provider connection lost after acceptance");
    if (scenario === "resolved-rejection")
      return Response.json(
        {
          name: "validation_error",
          message: "recipient-private-value",
          statusCode: 400,
        },
        { status: 400 },
      );
    return Response.json({
      data: payload.map((_, i) => ({ id: `fixture-${fetchAttempts}-${i}` })),
    });
  },
  { preconnect: () => blockNetwork("preconnect") },
);
const deadline = setTimeout(() => {
  console.error("Payment issue fixture deadline exceeded");
  process.exit(124);
}, 15_000);

async function run() {
  if (scenario === "registry-import") {
    const bullmq = { ...(await import("bullmq")) };
    class NoNetworkQueue {
      constructor(
        readonly name: string,
        readonly opts: unknown,
      ) {}
      on() {
        return this;
      }
      async close() {}
    }
    mock.module("bullmq", () => ({ ...bullmq, Queue: NoNetworkQueue }));
    const registry = await import("../../registry");
    return {
      imported: true,
      registeredJobs: [
        "payment-issue",
        "enrich-transactions",
        "process-document",
        "notification",
        "reconcile-notification-dispatches",
      ].filter((name) => registry.hasProcessor(name)),
    };
  }
  // Only persistence is substituted; processor, mail service, templates and SDK
  // all execute. The separate PostgreSQL suite checks the real fence transitions.
  mock.module("../../../utils/db", () => ({ getDb: () => ({}) }));
  mock.module("@midday/db/queries", () => ({
    shouldSendNotification: async () => true,
  }));
  mock.module("@midday/db/queries/notification-dispatches", () => ({
    notificationDispatchOperationKey: (kind: string, id: string) =>
      createHash("sha256").update(`${kind}:${id}`).digest("hex"),
    ensureNotificationDispatch: async (_db: unknown, input: any) => {
      let row = rows.get(input.operationKey);
      if (!row) {
        row = {
          ...input,
          id: `dispatch-${rows.size + 1}`,
          status: "pending",
          attempts: 0,
          startedAt: null,
        };
        rows.set(input.operationKey, row);
      }
      return row;
    },
    beginNotificationDispatch: async (
      _db: unknown,
      scope: any,
      ready: boolean,
    ) => {
      const row = rows.get(scope.operationKey);
      if (row.status !== "pending")
        return {
          state: row.status === "dispatching" ? "busy" : row.status,
          row,
        };
      if (!ready) return { state: "pending", row };
      row.status = "dispatching";
      row.attempts++;
      row.startedAt = "fixture";
      return { state: "claimed", row, token: "fixture-fence" };
    },
    finishNotificationDispatch: async (
      _db: unknown,
      scope: any,
      outcome: any,
    ) => {
      const row = rows.get(scope.operationKey);
      row.outcome = outcome;
      row.status =
        scenario === "send-error"
          ? "reconciliation"
          : scenario === "resolved-rejection"
            ? "rejected"
            : "completed";
      return row;
    },
    interruptNotificationDispatch: async (_db: unknown, scope: any) => {
      rows.get(scope.operationKey).status = "reconciliation";
    },
    stopPendingNotificationDispatch: async () => {
      throw new Error("Unexpected expiry check for payment issue");
    },
  }));
  const { PaymentIssueProcessor } = await import("../payment-issue");
  const processor = new PaymentIssueProcessor();
  const job = (index: number) =>
    ({
      id: `fixture-job-${index}`,
      data: {
        teamId: "00000000-0000-4000-8000-000000000001",
        email: `recipient-${index}@example.test`,
        fullName: `FixtureName${index} FixtureSurname`,
        teamName: `FixtureTeam${index}`,
      },
    }) as Job<PaymentIssuePayload>;
  if (scenario === "configured-send") {
    const first = await processor.process(job(0));
    const duplicate = await processor.process(job(0));
    const second = await processor.process(job(1));
    return {
      imported: true,
      first,
      duplicate,
      second,
      requests,
      states: [...rows.values()].map(
        ({ status, attempts, startedAt, outcome }) => ({
          status,
          attempts,
          startedAt,
          outcome,
        }),
      ),
    };
  }
  const errors: Array<{ name: string; message: string }> = [];
  for (let i = 0; i < 2; i++) {
    try {
      await processor.process(job(0));
      throw new Error("Expected dispatch to remain incomplete");
    } catch (error) {
      errors.push({
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return {
    imported: true,
    errors,
    requests,
    states: [...rows.values()].map(
      ({ status, attempts, startedAt, outcome }) => ({
        status,
        attempts,
        startedAt,
        outcome,
      }),
    ),
  };
}
try {
  const result = await run();
  console.log(
    `PAYMENT_ISSUE_FIXTURE ${JSON.stringify({ ...result, fetchAttempts, networkAttempts })}`,
  );
  process.exitCode = 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.exit(process.exitCode ?? 0);
}
