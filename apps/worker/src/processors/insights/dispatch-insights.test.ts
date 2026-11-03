import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import type { Job, JobsOptions } from "bullmq";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const originalEnabled = process.env.INSIGHTS_ENABLED;
const blockNetwork = (): never => {
  throw new Error("Unexpected real network in insight admission fixture");
};
globalThis.fetch = Object.assign(blockNetwork, originalFetch);
Socket.prototype.connect = blockNetwork;

const firstTeam = "40000000-0000-4000-8000-000000000001";
const secondTeam = "40000000-0000-4000-8000-000000000002";
let teamIds = [firstTeam, secondTeam];
let blockedTeam: string | undefined;
let loseAcknowledgement = false;
const events: string[] = [];
const reservations: Array<{
  queue: string;
  payload: unknown;
  id: string;
  name?: string;
}> = [];
const added: Array<{ name: string; payload: unknown; options: JobsOptions }> =
  [];

mock.module("@midday/db/queries", () => ({
  getTeamsForInsights: async () =>
    teamIds.map((id) => ({ id, baseCurrency: "USD", ownerLocale: "en" })),
  getInsightByPeriod: async () => null,
}));
mock.module("@midday/insights", () => ({
  getEnabledTeamIds: () => undefined,
  getPreviousCompletePeriod: () => ({
    periodYear: 2026,
    periodNumber: 44,
    periodLabel: "Week 44",
  }),
}));
mock.module("../../utils/db", () => ({ getDb: () => ({}) }));
mock.module("../base", () => ({
  BaseProcessor: class {
    protected logger = { info() {}, debug() {}, warn() {}, error() {} };
  },
}));
mock.module("@midday/job-client/resource-admission", () => ({
  reserveQueuedJob: async (
    queue: string,
    payload: { teamId: string },
    id?: string,
    name?: string,
  ) => {
    events.push(`reserve:${payload.teamId}`);
    if (!id) throw new Error("Missing insight period identity");
    reservations.push({ queue, payload, id, name });
    if (payload.teamId === blockedTeam)
      throw new Error("Fixture capacity exhausted");
    return id;
  },
  releaseQueuedJob: async () => {
    throw new Error("An ambiguous insight add must not release admission");
  },
}));
mock.module("../../queues/insights", () => ({
  insightsQueue: {
    add: async (
      name: string,
      payload: { teamId: string },
      options: JobsOptions,
    ) => {
      events.push(`add:${payload.teamId}`);
      added.push({ name, payload, options });
      if (loseAcknowledgement) throw new Error("Lost queue acknowledgement");
      return { id: options.jobId };
    },
  },
}));

const { DispatchInsightsProcessor } = await import("./dispatch-insights");
const processor = new DispatchInsightsProcessor();
// The real dispatcher's process method reads only data; queue/DB boundaries are fake.
const job = { data: { periodType: "weekly" } } as Job<{ periodType: "weekly" }>;

beforeEach(() => {
  process.env.INSIGHTS_ENABLED = "true";
  teamIds = [firstTeam, secondTeam];
  blockedTeam = undefined;
  loseAcknowledgement = false;
  events.length = 0;
  reservations.length = 0;
  added.length = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
  if (originalEnabled === undefined) delete process.env.INSIGHTS_ENABLED;
  else process.env.INSIGHTS_ENABLED = originalEnabled;
});

describe("insight dispatcher admission", () => {
  test("each tenant is admitted before Queue.add while period identity, stagger and backoff remain intact", async () => {
    const result = await processor.process(job);
    expect(result.dispatched).toBe(2);
    expect(result.skipped).toBe(0);
    expect(events).toEqual([
      `reserve:${firstTeam}`,
      `add:${firstTeam}`,
      `reserve:${secondTeam}`,
      `add:${secondTeam}`,
    ]);
    expect(reservations).toEqual(
      teamIds.map((teamId) => ({
        queue: "insights",
        name: "generate-team-insights",
        id: `insights-${teamId}-weekly-2026-44`,
        payload: {
          teamId,
          periodType: "weekly",
          periodYear: 2026,
          periodNumber: 44,
          currency: "USD",
          locale: "en",
        },
      })),
    );
    expect(added.map((item) => item.options)).toEqual(
      teamIds.map((teamId, index) => ({
        jobId: `insights-${teamId}-weekly-2026-44`,
        delay: index * 15000,
        attempts: 3,
        backoff: { type: "exponential", delay: 60000 },
      })),
    );
  });
  test("a capacity denial never reaches Queue.add and does not block another eligible team", async () => {
    blockedTeam = firstTeam;
    const result = await processor.process(job);
    expect(result.dispatched).toBe(1);
    expect(result.skipReasons.queueError).toBe(1);
    expect(result.errors).toEqual([
      { teamId: firstTeam, error: "Fixture capacity exhausted" },
    ]);
    expect(events).toEqual([
      `reserve:${firstTeam}`,
      `reserve:${secondTeam}`,
      `add:${secondTeam}`,
    ]);
    expect(added).toHaveLength(1);
    expect(added[0]?.options.delay).toBe(0);
  });
  test("a lost acknowledgement retains the same team/period admission identity on redispatch", async () => {
    teamIds = [firstTeam];
    loseAcknowledgement = true;
    const first = await processor.process(job);
    expect(first.dispatched).toBe(0);
    expect(first.skipReasons.queueError).toBe(1);
    loseAcknowledgement = false;
    const retry = await processor.process(job);
    expect(retry.dispatched).toBe(1);
    expect(reservations).toHaveLength(2);
    expect(reservations[1]?.id).toBe(reservations[0]?.id);
    expect(added[1]?.options.jobId).toBe(added[0]?.options.jobId);
  });
});
