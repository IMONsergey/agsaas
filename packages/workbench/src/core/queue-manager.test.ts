import { describe, expect, it, mock } from "bun:test";
import type { Job, JobNode, JobType, Queue } from "bullmq";
import { LRUCache } from "lru-cache";
import { QueueManager } from "./queue-manager";
import type { JobStatus } from "./types";

type TrackedJob = { job: Job; state: JobStatus; removed: boolean };

function makeJob(
  id: string,
  timestamp = Date.now(),
  state: JobStatus = "waiting",
  data: unknown = {},
): TrackedJob {
  const entry = { state, removed: false } as TrackedJob;
  entry.job = {
    id,
    name: "invoice-job",
    queueName: "invoices",
    timestamp,
    processedOn: state === "completed" ? timestamp - 100 : undefined,
    finishedOn: state === "completed" ? timestamp : undefined,
    data,
    opts: {},
    progress: 0,
    attemptsMade: 0,
    getState: mock(async () => entry.state),
    retry: mock(async () => {
      entry.state = "waiting";
    }),
    remove: mock(async () => {
      entry.removed = true;
    }),
    promote: mock(async () => {
      entry.state = "waiting";
    }),
  } as unknown as Job;
  return entry;
}

function makeQueue(
  entries: TrackedJob[] = [],
  name = "invoices",
  prefix = "tenant:v1",
) {
  let paused = false;
  const range = (
    key: string,
    start: number,
    end: number,
    limit: number,
    ascending: boolean,
  ) =>
    entries
      .filter(
        ({ job, state, removed }) =>
          !removed &&
          key.endsWith(`:${state}`) &&
          job.finishedOn !== undefined &&
          job.finishedOn >= start &&
          job.finishedOn <= end,
      )
      .sort((a, b) =>
        ascending
          ? a.job.finishedOn! - b.job.finishedOn!
          : b.job.finishedOn! - a.job.finishedOn!,
      )
      .slice(0, limit)
      .map(({ job }) => job.id!);
  const redis = {
    defineCommand: mock(
      (
        _name: string,
        _definition: Parameters<Awaited<Queue["client"]>["defineCommand"]>[1],
      ) => {},
    ),
    runCommand: mock(
      async (_name: string, args: unknown[]): Promise<unknown> => {
        const [key, start, end, limit, direction] = args;
        if (
          typeof key !== "string" ||
          typeof start !== "number" ||
          typeof end !== "number" ||
          typeof limit !== "number" ||
          (direction !== "asc" && direction !== "desc")
        ) {
          throw new Error("Invalid range arguments");
        }
        return range(key, start, end, limit, direction === "asc");
      },
    ),
  };
  const methods = {
    name,
    opts: { prefix },
    client: Promise.resolve(redis),
    toKey: (type: string) => `${prefix}:${name}:${type}`,
    getJobCounts: mock(async () => {
      const counts: Record<string, number> = {};
      for (const entry of entries) {
        if (!entry.removed) {
          counts[entry.state] = (counts[entry.state] ?? 0) + 1;
        }
      }
      return counts;
    }),
    getJobs: mock(
      async (types: JobType | JobType[], start = 0, end = -1, asc = false) => {
        const selected = Array.isArray(types) ? types : [types];
        // BullMQ applies the requested range to each state, then merges IDs.
        return selected.flatMap((type) =>
          entries
            .filter(({ state, removed }) => !removed && state === type)
            .map(({ job }) => job)
            .sort((a, b) =>
              asc ? a.timestamp - b.timestamp : b.timestamp - a.timestamp,
            )
            .slice(start, end < 0 ? undefined : end + 1),
        );
      },
    ),
    getJob: mock(
      async (id: string) =>
        entries.find((entry) => !entry.removed && entry.job.id === id)?.job,
    ),
    isPaused: mock(async () => paused),
    pause: mock(async () => {
      paused = true;
    }),
    resume: mock(async () => {
      paused = false;
    }),
    clean: mock(async (_grace: number, _limit: number, status: string) => {
      const matches = entries.filter(
        (entry) => !entry.removed && entry.state === status,
      );
      for (const entry of matches) entry.removed = true;
      return matches.map(({ job }) => job.id!);
    }),
    add: mock(async (jobName: string, data: unknown) => {
      const entry = makeJob(
        `new-${entries.length}`,
        Date.now(),
        "waiting",
        data,
      );
      entry.job.name = jobName;
      entries.push(entry);
      return entry.job;
    }),
  };
  return { queue: methods as unknown as Queue, methods, entries, redis };
}

describe("QueueManager Redis access", () => {
  it("awaits the Redis client and respects a custom queue prefix", async () => {
    const fixture = makeQueue([makeJob("1", Date.now() - 1000, "completed")]);
    const manager = new QueueManager([fixture.queue]);
    const activity = await manager.getActivityStats();

    expect(activity.totalCompleted).toBe(1);
    expect(
      fixture.redis.runCommand.mock.calls.map((call) => call[1][0]),
    ).toEqual(["tenant:v1:invoices:completed", "tenant:v1:invoices:failed"]);
    expect(fixture.redis.defineCommand).toHaveBeenCalledTimes(1);
    expect(fixture.redis.defineCommand.mock.calls[0]?.[1]).toMatchObject({
      numberOfKeys: 1,
      readOnly: true,
    });
    expect(fixture.methods.getJobs).not.toHaveBeenCalled();
  });

  it("falls back to ordinary job reads when the Redis range query fails", async () => {
    const fixture = makeQueue([makeJob("1", Date.now() - 1000, "completed")]);
    fixture.redis.runCommand.mockImplementation(async () => {
      throw new Error("range query unavailable");
    });
    const manager = new QueueManager([fixture.queue]);
    expect((await manager.getActivityStats()).totalCompleted).toBe(1);
    expect(fixture.methods.getJobs).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed command responses before reading job IDs", async () => {
    const fixture = makeQueue([makeJob("1", Date.now() - 1000, "completed")]);
    fixture.redis.runCommand.mockImplementation(async () => ["1", 42]);
    const manager = new QueueManager([fixture.queue]);
    expect((await manager.getActivityStats()).totalCompleted).toBe(1);
    expect(fixture.methods.getJobs).toHaveBeenCalledTimes(2);
    expect(fixture.methods.getJob).not.toHaveBeenCalled();
  });
});

describe("QueueManager mutation cache consistency", () => {
  it("does not extend data freshness indefinitely under frequent polling", async () => {
    const fixture = makeQueue([makeJob("initial")]);
    const manager = new QueueManager([fixture.queue]);
    let now = 1;
    const internal = manager as unknown as {
      cache: LRUCache<string, object>;
      countCache: LRUCache<string, Record<string, number>>;
    };
    internal.cache = new LRUCache({
      max: 100,
      ttlResolution: 0,
      perf: { now: () => now },
      updateAgeOnGet: internal.cache.updateAgeOnGet,
    });
    internal.countCache = new LRUCache({
      max: 100,
      ttl: 5000,
      ttlResolution: 0,
      perf: { now: () => now },
    });

    expect((await manager.getQueues())[0]?.counts.waiting).toBe(1);
    fixture.entries.push(makeJob("external-worker-job"));
    now = 60_001;
    expect((await manager.getQueues())[0]?.counts.waiting).toBe(1);
    now = 120_002;
    expect((await manager.getQueues())[0]?.counts.waiting).toBe(2);
  });

  for (const action of [
    { method: "retryJob", initial: "failed", waiting: 1 },
    { method: "promoteJob", initial: "delayed", waiting: 1 },
    { method: "removeJob", initial: "waiting", waiting: 0 },
  ] as const) {
    it(`invalidates queue summaries and quick counts after ${action.method}`, async () => {
      const fixture = makeQueue([makeJob("1", Date.now(), action.initial)]);
      const manager = new QueueManager([fixture.queue]);
      await manager.getQueues();
      await manager.getQuickCounts();
      await manager.getJob("invoices", "1");

      expect(await manager[action.method]("invoices", "1")).toBe(true);
      expect((await manager.getQueues())[0]?.counts.waiting).toBe(
        action.waiting,
      );
      expect((await manager.getQuickCounts()).waiting).toBe(action.waiting);
      if (action.method !== "removeJob") {
        expect((await manager.getJob("invoices", "1"))?.status).toBe("waiting");
      }
    });
  }

  it("refreshes pause and resume state immediately", async () => {
    const fixture = makeQueue();
    const manager = new QueueManager([fixture.queue]);
    expect((await manager.getQueues())[0]?.isPaused).toBe(false);
    await manager.pauseQueue("invoices");
    expect((await manager.getQueues())[0]?.isPaused).toBe(true);
    await manager.resumeQueue("invoices");
    expect((await manager.getQueues())[0]?.isPaused).toBe(false);
  });

  it("refreshes counts after enqueue and cleanup", async () => {
    const fixture = makeQueue([makeJob("old", Date.now(), "completed")]);
    const manager = new QueueManager([fixture.queue]);
    expect((await manager.getQuickCounts()).total).toBe(1);
    await manager.enqueueJob({
      queueName: "invoices",
      jobName: "new",
      data: {},
    });
    expect((await manager.getQuickCounts()).total).toBe(2);
    expect(await manager.cleanJobs("invoices", "completed")).toBe(1);
    expect((await manager.getQuickCounts()).completed).toBe(0);
    expect((await manager.getQueues())[0]?.counts.waiting).toBe(1);
  });

  it("clears lower-level counts and state caches on manual refresh", async () => {
    const entry = makeJob("1");
    const fixture = makeQueue([entry]);
    const manager = new QueueManager([fixture.queue]);
    await manager.getQuickCounts();
    await manager.getJob("invoices", "1");
    entry.state = "completed";
    manager.clearCache();

    expect((await manager.getQuickCounts()).completed).toBe(1);
    expect((await manager.getJob("invoices", "1"))?.status).toBe("completed");
  });

  it("does not restore stale cache entries from an in-flight read", async () => {
    const fixture = makeQueue([makeJob("1", Date.now(), "failed")]);
    let finishRead!: (counts: Record<string, number>) => void;
    fixture.methods.getJobCounts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const manager = new QueueManager([fixture.queue]);
    const staleRead = manager.getQuickCounts();
    await manager.retryJob("invoices", "1");
    finishRead({ failed: 1 });
    await staleRead;

    expect((await manager.getQuickCounts()).waiting).toBe(1);
    expect((await manager.getQueues())[0]?.counts.failed).toBe(0);
  });
});

describe("QueueManager pagination and search", () => {
  it("keeps non-timestamp pages stable within a fixed recent-job window", async () => {
    const fixture = makeQueue(
      Array.from({ length: 1005 }, (_, i) => {
        const entry = makeJob(String(i), 10_000 - i);
        entry.job.name = String(1004 - i).padStart(4, "0");
        return entry;
      }),
    );
    const manager = new QueueManager([fixture.queue]);
    const ids: string[] = [];
    for (let start = 0; start <= 1000; start += 100) {
      const page = await manager.getAllRuns(100, start, {
        field: "name",
        direction: "asc",
      });
      ids.push(...page.data.map(({ id }) => id));
      expect(page.hasMore).toBe(start < 900);
      expect(page.cursor).toBe(start < 900 ? String(start + 100) : undefined);
    }
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
    expect(ids).toEqual(
      Array.from({ length: 1000 }, (_, i) => String(999 - i)),
    );
    expect(
      fixture.methods.getJobs.mock.calls.every((call) => call[2] === 999),
    ).toBe(true);
  });

  for (const direction of ["asc", "desc"] as const) {
    it(`selects range candidates in ${direction} order before Redis LIMIT`, async () => {
      const fixture = makeQueue(
        Array.from({ length: 120 }, (_, i) =>
          makeJob(String(i), 1000 - i, "completed"),
        ),
      );
      const manager = new QueueManager([fixture.queue]);
      const page = await manager.getAllRuns(
        20,
        50,
        { field: "timestamp", direction },
        { status: "completed", timeRange: { start: 0, end: 2000 } },
      );
      expect(page.data.map(({ id }) => id)).toEqual(
        Array.from({ length: 20 }, (_, i) =>
          String(direction === "desc" ? 50 + i : 69 - i),
        ),
      );
      expect(fixture.methods.getJobs).not.toHaveBeenCalled();
    });

    it(`includes exact score boundaries in ${direction} ranges`, async () => {
      const fixture = makeQueue(
        Array.from({ length: 5 }, (_, i) => {
          const entry = makeJob(String(i), 1000 + i, "completed");
          entry.job.processedOn = entry.job.finishedOn;
          return entry;
        }),
      );
      const page = await new QueueManager([fixture.queue]).getAllRuns(
        10,
        0,
        { field: "timestamp", direction },
        { status: "completed", timeRange: { start: 1001, end: 1003 } },
      );
      expect(page.data.map(({ id }) => id)).toEqual(
        direction === "asc" ? ["1", "2", "3"] : ["3", "2", "1"],
      );
      expect(fixture.methods.getJobs).not.toHaveBeenCalled();
    });
  }

  it("preserves ascending order in the Redis-error range fallback", async () => {
    const fixture = makeQueue(
      Array.from({ length: 30 }, (_, i) =>
        makeJob(String(i), 1000 - i, "completed"),
      ),
    );
    fixture.redis.runCommand.mockImplementation(async () => {
      throw new Error("range query unavailable");
    });
    const page = await new QueueManager([fixture.queue]).getAllRuns(
      2,
      0,
      { field: "timestamp", direction: "asc" },
      { status: "completed", timeRange: { start: 0, end: 2000 } },
    );
    expect(page.data.map(({ id }) => id)).toEqual(["29", "28"]);
  });

  it("does not query Redis for the display-only unknown state", async () => {
    const fixture = makeQueue();
    const manager = new QueueManager([fixture.queue]);
    expect(await manager.getJobs("invoices", "unknown")).toEqual({
      data: [],
      total: 0,
      hasMore: false,
    });
    expect(
      await manager.getAllRuns(20, 0, undefined, { status: "unknown" }),
    ).toEqual({
      data: [],
      total: 0,
      hasMore: false,
    });
    expect(fixture.methods.getJobs).not.toHaveBeenCalled();
  });

  it("keeps the requested offset when a status filter is active", async () => {
    const busy = makeQueue(
      Array.from({ length: 120 }, (_, i) => makeJob(String(i), 1000 - i)),
    );
    const empty = makeQueue([], "empty");
    const manager = new QueueManager([busy.queue, empty.queue]);
    const page = await manager.getAllRuns(20, 50, undefined, {
      status: "waiting",
    });

    expect(page.data.map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 50)),
    );
    expect(page.hasMore).toBe(true);
  });

  it("sorts all candidates by name before selecting a page", async () => {
    const entries = ["zeta", "alpha", "beta", "gamma", "delta"].map(
      (name, i) => {
        const entry = makeJob(String(i), 100 - i);
        entry.job.name = name;
        return entry;
      },
    );
    const fixture = makeQueue(entries);
    const page = await new QueueManager([fixture.queue]).getAllRuns(2, 1, {
      field: "name",
      direction: "asc",
    });

    expect(page.data.map(({ name }) => name)).toEqual(["beta", "delta"]);
    expect(page.hasMore).toBe(true);
  });

  it("requests the oldest candidates when timestamp sorting is ascending", async () => {
    const fixture = makeQueue(
      Array.from({ length: 120 }, (_, i) => makeJob(String(i), 1000 - i)),
    );
    const manager = new QueueManager([fixture.queue]);
    const page = await manager.getAllRuns(20, 20, {
      field: "timestamp",
      direction: "asc",
    });
    expect(page.data.map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(99 - i)),
    );
    const queuePage = await manager.getJobs("invoices", "waiting", 20, 20, {
      field: "timestamp",
      direction: "asc",
    });
    expect(queuePage.data.map(({ id }) => id)).toEqual(
      page.data.map(({ id }) => id),
    );
  });

  it("does not lose later pages when jobs are concentrated in one queue", async () => {
    const busy = makeQueue(
      Array.from({ length: 120 }, (_, i) => makeJob(String(i), 1000 - i)),
    );
    const empty = makeQueue([], "empty");
    const manager = new QueueManager([busy.queue, empty.queue]);
    const first = await manager.getAllRuns(50, 0);
    const second = await manager.getAllRuns(50, 50);
    const last = await manager.getAllRuns(50, 100);

    expect(first.data).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.data.map((job) => job.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => String(i + 50)),
    );
    expect(second.hasMore).toBe(true);
    expect(last.data).toHaveLength(20);
    expect(last.hasMore).toBe(false);
  });

  it("paginates a merged queue list after sorting all selected states", async () => {
    const fixture = makeQueue([
      makeJob("w1", 100, "waiting"),
      makeJob("w2", 80, "waiting"),
      makeJob("w3", 60, "waiting"),
      makeJob("f1", 90, "failed"),
      makeJob("f2", 70, "failed"),
      makeJob("f3", 50, "failed"),
    ]);
    const page = await new QueueManager([fixture.queue]).getJobs(
      "invoices",
      undefined,
      2,
      2,
    );
    expect(page.data.map((job) => job.id)).toEqual(["w2", "f2"]);
    expect(page.total).toBe(6);
    expect(page.cursor).toBe("4");
  });

  it("keeps searching after a job with absent data", async () => {
    const missing = makeJob("empty", 100);
    missing.job.data = undefined;
    const matching = makeJob("matching", 90, "waiting", { note: "needle" });
    const fixture = makeQueue([missing, matching]);
    const manager = new QueueManager([fixture.queue]);
    expect((await manager.search("needle")).map(({ job }) => job.id)).toEqual([
      "matching",
    ]);
    expect(
      (await manager.getAllRuns(10, 0, undefined, { text: "needle" })).data.map(
        ({ id }) => id,
      ),
    ).toEqual(["matching"]);
  });

  it("resolves parent queue names with multi-part custom prefixes", async () => {
    const entry = makeJob("child");
    entry.job.parent = { id: "parent", queueKey: "tenant:v1:parents" };
    const fixture = makeQueue([entry]);
    const job = await new QueueManager([fixture.queue]).getJob(
      "invoices",
      "child",
    );
    expect(job?.parent).toEqual({ id: "parent", queueName: "parents" });
  });
});

describe("QueueManager flow prefixes", () => {
  it("reads and creates flows using the configured queue prefix", async () => {
    const fixture = makeQueue();
    const manager = new QueueManager([fixture.queue]);
    const tree: JobNode = { job: makeJob("root").job };
    const producer = {
      getFlow: mock(async () => tree),
      add: mock(async () => tree),
    };
    (manager as unknown as { flowProducer: typeof producer }).flowProducer =
      producer;

    expect((await manager.getFlow("invoices", "root"))?.job.id).toBe("root");
    expect(producer.getFlow).toHaveBeenCalledWith({
      id: "root",
      queueName: "invoices",
      prefix: "tenant:v1",
    });
    await manager.createFlow({
      name: "root",
      queueName: "invoices",
      data: { amount: 12 },
      children: [{ name: "child", queueName: "invoices", data: { amount: 4 } }],
    });
    expect(producer.add).toHaveBeenCalledWith({
      name: "root",
      queueName: "invoices",
      prefix: "tenant:v1",
      data: { amount: 12 },
      children: [
        {
          name: "child",
          queueName: "invoices",
          prefix: "tenant:v1",
          data: { amount: 4 },
        },
      ],
    });
  });
});
