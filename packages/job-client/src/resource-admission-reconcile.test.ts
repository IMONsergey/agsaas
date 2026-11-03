import { beforeEach, describe, expect, mock, test } from "bun:test";

const teamId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const replacementGeneration = "33333333-3333-4333-8333-333333333333";
const member = JSON.stringify({
  teamId,
  queueName: "documents",
  id: "fixture-job",
});
const globalKey = "agsaas:{resource-admission}:queued";
const keys = [
  globalKey,
  `agsaas:{resource-admission}:team:${teamId}`,
  "agsaas:{resource-admission}:generations",
  "agsaas:{resource-admission}:retry-intents",
];
let state: string | null = null;
let metadata: unknown = ["reserved", generation, "none"];
let releaseReply: 0 | 1 = 1;
let afterObserve: (() => void) | undefined;
const order: string[] = [];
const capture = mock(async () => {
  order.push("capture");
  return metadata;
});
const release = mock(async (_generation: string) => {
  order.push("release");
  return releaseReply;
});
const rotate = mock(async () => 1);
const getState = mock(async () => {
  order.push("observe");
  const observed = state;
  afterObserve?.();
  return observed;
});
const getJob = mock(async () => {
  order.push("lookup");
  return state === null ? null : { getState };
});

// This fake supplies the public adapter's operation responses. It does not
// interpret or emulate Lua; the separate real Redis suites prove atomic CAS.
const definitions = new Map<string, { numberOfKeys: number }>();
const redis = {
  defineCommand: (
    name: string,
    options: { numberOfKeys: number; lua: string },
  ) => {
    definitions.set(name, { numberOfKeys: options.numberOfKeys });
  },
  zrange: async (
    key: string,
    start: number,
    end: number,
    options: { WITHSCORES?: boolean },
  ) => {
    expect([key, start, end, options]).toEqual([
      globalKey,
      0,
      99,
      { WITHSCORES: true },
    ]);
    return [member, String(Date.now() - 60 * 60_000)];
  },
  runCommand: async (name: string, args: Array<string | number>) => {
    switch (name) {
      case "agsaasCaptureQueuedJobV2":
        expect(definitions.get(name)?.numberOfKeys).toBe(4);
        expect(args).toEqual([...keys, member]);
        return capture();
      case "agsaasReleaseQueuedJobV2":
        expect(definitions.get(name)?.numberOfKeys).toBe(4);
        expect(args.slice(0, 5)).toEqual([...keys, member]);
        expect(args).toHaveLength(6);
        return release(String(args[5]));
      case "agsaasRotateQueuedJobV1":
        expect(definitions.get(name)?.numberOfKeys).toBe(1);
        expect(args.slice(0, 2)).toEqual([globalKey, member]);
        expect(args).toHaveLength(3);
        expect(Number.isSafeInteger(args[2])).toBe(true);
        return rotate();
      default:
        throw new Error(`Unexpected reconciliation command: ${name}`);
    }
  },
};
mock.module("./queues", () => ({
  getQueue: () => ({ client: Promise.resolve(redis), getJob }),
}));
const { inspectQueuedReservations, reconcileQueuedJobs } = await import(
  "./resource-admission"
);

describe("queued reservation reconciliation", () => {
  beforeEach(() => {
    state = null;
    metadata = ["reserved", generation, "none"];
    releaseReply = 1;
    afterObserve = undefined;
    order.length = 0;
    capture.mockClear();
    release.mockClear();
    rotate.mockClear();
    getJob.mockClear();
    getState.mockClear();
  });
  test("an old missing job remains reserved because its producer may still enqueue", async () => {
    expect(await reconcileQueuedJobs()).toBe(0);
    expect(release).not.toHaveBeenCalled();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(await inspectQueuedReservations()).toEqual([
      expect.objectContaining({
        teamId,
        id: "fixture-job",
        state: "missing-unconfirmed",
        admission: "none",
      }),
    ]);
  });
  test("live and unknown jobs remain reserved", async () => {
    for (const value of [
      "waiting",
      "active",
      "delayed",
      "prioritized",
      "paused",
      "waiting-children",
      "unknown",
    ]) {
      state = value;
      expect(await reconcileQueuedJobs()).toBe(0);
    }
    expect(release).not.toHaveBeenCalled();
    expect(rotate).toHaveBeenCalledTimes(7);
  });
  test("only confirmed terminal jobs release the generation captured before observing state", async () => {
    for (const value of ["completed", "failed"]) {
      order.length = 0;
      state = value;
      expect(await reconcileQueuedJobs()).toBe(1);
      expect(order).toEqual(["capture", "lookup", "observe", "release"]);
    }
    expect(release.mock.calls).toEqual([[generation], [generation]]);
    expect(rotate).not.toHaveBeenCalled();
  });
  test("a retry after terminal observation retains its replacement generation", async () => {
    state = "completed";
    afterObserve = () => {
      metadata = ["reserved", replacementGeneration, "dispatched"];
      // The real Redis CAS reports that the captured generation is stale.
      releaseReply = 0;
    };
    expect(await reconcileQueuedJobs()).toBe(0);
    expect(order).toEqual(["capture", "lookup", "observe", "release"]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(release.mock.calls).toEqual([[generation]]);
    expect(metadata).toEqual(["reserved", replacementGeneration, "dispatched"]);
    expect(rotate).not.toHaveBeenCalled();
  });
  test("pending or malformed admission cannot reach a terminal release", async () => {
    state = "failed";
    for (const value of [["reserved", "pending"], ["invalid", ""], 1]) {
      metadata = value;
      expect(await reconcileQueuedJobs()).toBe(0);
    }
    expect(getJob).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(rotate).toHaveBeenCalledTimes(3);
  });
});
