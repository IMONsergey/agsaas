import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import type { Job } from "bullmq";

const previousFetch = globalThis.fetch;
const previousConnect = Socket.prototype.connect;
const block = (): never => {
  throw new Error("Network forbidden in recovery processor fixture");
};
globalThis.fetch = Object.assign(async () => block(), { preconnect: block });
Socket.prototype.connect = block;
const due = [
  { teamId: "team-a", invoiceId: "invoice-a", operationKey: "a".repeat(64) },
  { teamId: "team-b", invoiceId: "invoice-b", operationKey: "b".repeat(64) },
];
const calls: unknown[] = [];
const warnings: unknown[] = [];
let failure: Error | null = null;
mock.module("@midday/db/queries", () => ({
  listRecoverableInvoiceEmailDeliveries: async (
    _db: unknown,
    limit: number,
  ) => {
    expect(limit).toBe(25);
    return due;
  },
}));
mock.module("@midday/db/worker-client", () => ({ getWorkerDb: () => ({}) }));
mock.module("@midday/notifications", () => ({
  Notifications: class {
    async reconcileInvoiceDelivery(scope: unknown) {
      calls.push(scope);
      if (calls.length === 1 && failure) throw failure;
    }
  },
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info() {},
    error() {},
    debug() {},
    warn(...args: unknown[]) {
      warnings.push(args);
    },
  }),
}));
mock.module("@sentry/bun", () => ({ captureException() {} }));

const { ReconcileInvoiceDeliveriesProcessor } = await import(
  "./reconcile-invoice-deliveries"
);
const processor = new ReconcileInvoiceDeliveriesProcessor();
beforeEach(() => {
  calls.length = 0;
  warnings.length = 0;
  failure = null;
});
afterAll(() => {
  globalThis.fetch = previousFetch;
  Socket.prototype.connect = previousConnect;
});

describe("SQL receipt recovery processor", () => {
  test("uses only persisted identities, never rebuilds a customer payload", async () => {
    const result = await processor.process({} as Job<Record<string, never>>);
    expect(result).toEqual({ scanned: 2, completed: 2, deferred: 0 });
    expect(calls).toEqual(due);
  });
  test("one deferred receipt does not starve the rest or leak raw error parameters", async () => {
    failure = new Error(
      "secret customer@example.test; SQL HTML/PDF parameters",
    );
    const result = await processor.process({} as Job<Record<string, never>>);
    expect(result).toEqual({ scanned: 2, completed: 1, deferred: 1 });
    expect(calls).toEqual(due);
    expect(JSON.stringify(warnings)).not.toContain("customer@example.test");
    expect(JSON.stringify(warnings)).not.toContain("HTML/PDF");
  });
});
