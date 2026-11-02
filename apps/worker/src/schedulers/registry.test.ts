import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";

// Exercise the real scheduler configs, registry and lifecycle-owned queue
// instances. Only the external transport and unrelated DB access are replaced.
// Run in its own Bun process so these module mocks cannot affect other suites.
const savedFetch = globalThis.fetch;
const savedConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error(
    "Network and database access are forbidden in scheduler tests",
  );
};
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
Socket.prototype.connect = forbidden;

type Registration = {
  queue: FixtureQueue;
  id: string;
  repeat: unknown;
  template: unknown;
};
const registrations: Registration[] = [];
const removals: Array<{ queue: FixtureQueue; id: string }> = [];
class FixtureQueue {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  async upsertJobScheduler(id: string, repeat: unknown, template: unknown) {
    registrations.push({ queue: this, id, repeat, template });
    return {};
  }
  async removeJobScheduler(id: string) {
    removals.push({ queue: this, id });
    return true;
  }
}
mock.module("bullmq", () => ({
  Queue: FixtureQueue,
  UnrecoverableError: class extends Error {},
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
  }),
}));
mock.module("../config", () => ({
  getRedisConnection: () => ({ host: "127.0.0.1", port: 1 }),
}));
mock.module("@midday/db/queries", () => ({ updateDocumentByPath: forbidden }));
mock.module("../utils/db", () => ({ getDb: forbidden }));

const { getAllQueues, queueConfigs } = await import("../queues");
const { staticSchedulerConfigs } = await import("./index");
const {
  getRegisteredStaticSchedulers,
  registerStaticSchedulers,
  registerDynamicScheduler,
  unregisterDynamicScheduler,
} = await import("./registry");

beforeEach(() => {
  registrations.length = 0;
  removals.length = 0;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  Socket.prototype.connect = savedConnect;
});

describe("static scheduler queue registration", () => {
  test("removes a persisted inbox scheduler after a fresh process with no local registration", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    await unregisterDynamicScheduler("inbox-sync-scheduler", id);
    expect(removals).toHaveLength(1);
    expect(removals[0]?.id).toBe(`scheduler:inbox-sync-${id}`);
    expect(removals[0]?.queue).toBe(
      getAllQueues().find((queue) => queue.name === "inbox-provider"),
    );
    expect(registrations).toHaveLength(0);
  });
  test("repeated setup upserts persisted scheduler state instead of trusting the local map", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    await registerDynamicScheduler({
      template: "inbox-sync-scheduler",
      accountId: id,
      cronPattern: "5 */6 * * *",
    });
    await registerDynamicScheduler({
      template: "inbox-sync-scheduler",
      accountId: id,
      cronPattern: "10 */6 * * *",
    });
    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.id).toBe(registrations[1]?.id);
    expect(registrations[1]?.repeat).toMatchObject({ pattern: "10 */6 * * *" });
    await unregisterDynamicScheduler("inbox-sync-scheduler", id);
  });
  test("registers the real invitation recovery scheduler and every other configured scheduler", async () => {
    await registerStaticSchedulers();
    expect(registrations).toHaveLength(staticSchedulerConfigs.length);
    const queues = getAllQueues();
    for (const config of staticSchedulerConfigs) {
      const registration = registrations.find(
        (call) => call.id === `scheduler:${config.name}`,
      );
      expect(registration?.queue).toBe(
        queues.find((queue) => queue.name === config.queue),
      );
      expect(registration?.repeat).toMatchObject({
        pattern: config.cron,
        tz: config.options?.tz ?? "UTC",
      });
      expect(registration?.template).toMatchObject({
        name: config.jobName,
        data: config.payload ?? {},
      });
      expect(getRegisteredStaticSchedulers()).toContain(config.name);
    }
    const bankCleanup = registrations.find(
      (call) => call.id === "scheduler:reconcile-bank-connections",
    );
    expect(bankCleanup?.queue.name).toBe("teams");
    expect(bankCleanup?.template).toMatchObject({
      name: "reconcile-bank-connections",
      data: {},
    });
    const invitation = registrations.find(
      (call) => call.id === "scheduler:reconcile-team-invitations",
    );
    expect(invitation?.queue.name).toBe("teams");
    expect(invitation?.repeat).toMatchObject({
      pattern: "* * * * *",
      tz: "UTC",
    });
    expect(invitation?.template).toMatchObject({
      name: "reconcile-team-invitations",
      data: {},
    });
  });

  test("resolves every lifecycle-owned queue while retaining the unknown-queue guard", async () => {
    const queues = getAllQueues();
    expect(new Set(queues.map((queue) => queue.name)).size).toBe(queues.length);
    expect(queues.map((queue) => queue.name).sort()).toEqual(
      queueConfigs.map((config) => config.name).sort(),
    );
    const original = [...staticSchedulerConfigs];
    try {
      // Include queues that have no static schedule today, so a future scheduler
      // cannot silently diverge from the worker startup/shutdown queue registry.
      staticSchedulerConfigs.splice(
        0,
        staticSchedulerConfigs.length,
        ...queues.map((queue) => ({
          name: `fixture-${queue.name}`,
          queue: queue.name,
          cron: "0 * * * *",
          jobName: "fixture-scheduler",
        })),
      );
      await registerStaticSchedulers();
      expect(registrations).toHaveLength(queues.length);
      for (const queue of queues) {
        expect(
          registrations.find(
            (call) => call.id === `scheduler:fixture-${queue.name}`,
          )?.queue,
        ).toBe(queue);
      }
      registrations.length = 0;
      staticSchedulerConfigs.splice(0, staticSchedulerConfigs.length, {
        name: "unknown-fixture",
        queue: "unknown-fixture-queue",
        cron: "0 * * * *",
        jobName: "fixture-scheduler",
      });
      await expect(registerStaticSchedulers()).rejects.toThrow(
        "Unknown queue: unknown-fixture-queue",
      );
      expect(registrations).toHaveLength(0);
    } finally {
      staticSchedulerConfigs.splice(
        0,
        staticSchedulerConfigs.length,
        ...original,
      );
    }
  });
});
