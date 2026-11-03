import { describe, expect, test } from "bun:test";
import { financialJobId, financialRequestHash } from "@midday/db/financial-job";
import type { FinancialJobDispatch } from "@midday/db/queries/financial-job-dispatches";
import { invoiceDeliveryOperationKey } from "../processors/invoices/invoice-delivery-operation";
import {
  dispatchFinancialJob,
  type FinancialDispatchQueue,
} from "./financial-job-dispatch";

function fixture() {
  const payload = {
    teamId: "40000000-0000-4000-8000-000000000001",
    invoiceId: "40000000-0000-4000-8000-000000000002",
    deliveryType: "create_and_send",
    deliveryKey: "a".repeat(64),
  };
  const row: FinancialJobDispatch = {
    id: "40000000-0000-4000-8000-000000000003",
    teamId: payload.teamId,
    jobName: "generate-invoice",
    queueName: "invoices",
    operationKey: "b".repeat(64),
    payload,
    payloadHash: financialRequestHash(payload),
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
  };
  let state = "waiting";
  let failBefore = false;
  let failAfter = false;
  let calls = 0;
  let delay: number | undefined;
  let saved: Awaited<ReturnType<FinancialDispatchQueue["getJob"]>> = null;
  const queue: FinancialDispatchQueue = {
    async getJob() {
      return saved;
    },
    async add(name, data, options) {
      calls++;
      delay = options.delay;
      if (failBefore) throw new Error("queue unavailable");
      expect(options.removeOnComplete).toBe(false);
      expect(options.removeOnFail).toBe(false);
      saved = {
        name,
        data,
        getState: async () => state,
        remove: async () => {
          saved = null;
        },
      };
      if (failAfter) throw new Error("lost acknowledgement");
      return { id: options.jobId };
    },
  };
  return {
    row,
    queue,
    setState: (next: string) => {
      state = next;
    },
    failBefore: () => {
      failBefore = true;
    },
    recover: () => {
      failBefore = false;
      failAfter = false;
    },
    failAfter: () => {
      failAfter = true;
    },
    loseRedis: () => {
      saved = null;
    },
    calls: () => calls,
    delay: () => delay,
    exists: () => Boolean(saved),
  };
}

describe("durable financial queue handoff", () => {
  test("a queue outage after SQL commit is retryable with the same job identity", async () => {
    const f = fixture();
    f.failBefore();
    await expect(dispatchFinancialJob(f.row, f.queue)).rejects.toThrow(
      "queue unavailable",
    );
    f.recover();
    expect(await dispatchFinancialJob(f.row, f.queue)).toEqual({
      status: "accepted",
    });
    expect(await f.queue.getJob(financialJobId(f.row.id))).not.toBeNull();
  });
  test("a lost Queue.add acknowledgement reuses the accepted receipt instead of adding again", async () => {
    const f = fixture();
    f.failAfter();
    await expect(dispatchFinancialJob(f.row, f.queue)).rejects.toThrow(
      "lost acknowledgement",
    );
    f.recover();
    expect(await dispatchFinancialJob(f.row, f.queue)).toEqual({
      status: "accepted",
    });
    expect(f.calls()).toBe(1);
  });
  test("completion receipt remains until the caller acknowledges SQL, and a failed job is never silently retried", async () => {
    const f = fixture();
    await dispatchFinancialJob(f.row, f.queue);
    f.setState("completed");
    const done = await dispatchFinancialJob(f.row, f.queue);
    expect(done.status).toBe("completed");
    expect(f.exists()).toBe(true);
    if (done.status === "completed") await done.cleanup();
    expect(f.exists()).toBe(false);
    await dispatchFinancialJob(f.row, f.queue);
    f.setState("failed");
    expect(await dispatchFinancialJob(f.row, f.queue)).toEqual({
      status: "failed",
    });
  });
  test("Redis recreation retains the invoice delivery key despite a new BullMQ timestamp", async () => {
    const f = fixture();
    await dispatchFinancialJob(f.row, f.queue);
    f.loseRedis();
    await dispatchFinancialJob({ ...f.row, status: "accepted" }, f.queue);
    const key = (timestamp: number) =>
      invoiceDeliveryOperationKey({
        teamId: f.row.teamId,
        invoiceId: String(f.row.payload!.invoiceId),
        kind: "invoice",
        deliveryKey: String(f.row.payload!.deliveryKey),
        job: { id: financialJobId(f.row.id), name: f.row.jobName, timestamp },
      });
    expect(key(1000)).toBe(key(2000));
    expect(f.calls()).toBe(2);
  });
  test("a mutated persisted payload is rejected before contacting the queue", async () => {
    const f = fixture();
    await expect(
      dispatchFinancialJob(
        { ...f.row, payload: { ...f.row.payload, teamId: "foreign" } },
        f.queue,
      ),
    ).rejects.toThrow("Invalid persisted");
    expect(f.calls()).toBe(0);
  });
});

describe("persisted financial schedules", () => {
  test("Redis loss rebuilds the delay from the committed timestamp, including an overdue handoff", async () => {
    const f = fixture();
    const dueAt = Date.now() + 3600000;
    f.row.payload = {
      ...f.row.payload,
      notBefore: new Date(dueAt).toISOString(),
    };
    f.row.payloadHash = financialRequestHash(f.row.payload);
    await dispatchFinancialJob(f.row, f.queue);
    expect(f.delay()).toBeGreaterThan(3500000);
    expect(f.delay()).toBeLessThanOrEqual(3600000);
    f.loseRedis();
    f.row.payload = {
      ...f.row.payload,
      notBefore: new Date(Date.now() - 1000).toISOString(),
    };
    f.row.payloadHash = financialRequestHash(f.row.payload);
    await dispatchFinancialJob(f.row, f.queue);
    expect(f.delay()).toBe(0);
  });
  test("an invalid persisted timestamp never reaches Queue.add", async () => {
    const f = fixture();
    f.row.payload = { ...f.row.payload, notBefore: "invalid-fixture" };
    f.row.payloadHash = financialRequestHash(f.row.payload);
    await expect(dispatchFinancialJob(f.row, f.queue)).rejects.toThrow(
      "schedule",
    );
    expect(f.calls()).toBe(0);
  });
});
