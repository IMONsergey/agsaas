import { beforeEach, describe, expect, mock, test } from "bun:test";

const teamId = "11111111-1111-4111-8111-111111111111";
const member = JSON.stringify({
  teamId,
  queueName: "documents",
  id: "fixture-job",
});
let state: string | null = null;
const release = mock(async () => 1),
  rotate = mock(async () => 1);
const redis = {
  zrange: async () => [member, String(Date.now() - 60 * 60_000)],
  eval: release,
  zadd: rotate,
};
mock.module("./queues", () => ({
  getQueue: () => ({
    client: Promise.resolve(redis),
    getJob: async () =>
      state === null ? null : { getState: async () => state },
  }),
}));
const { inspectQueuedReservations, reconcileQueuedJobs } = await import(
  "./resource-admission"
);

describe("queued reservation reconciliation", () => {
  beforeEach(() => {
    state = null;
    release.mockClear();
    rotate.mockClear();
  });
  test("an old missing job remains reserved because its producer may still enqueue", async () => {
    expect(await reconcileQueuedJobs()).toBe(0);
    expect(release).not.toHaveBeenCalled();
    expect(await inspectQueuedReservations()).toEqual([
      expect.objectContaining({
        teamId,
        id: "fixture-job",
        state: "missing-unconfirmed",
      }),
    ]);
  });
  test("waiting, active, delayed and unknown jobs remain reserved", async () => {
    for (const value of ["waiting", "active", "delayed", "unknown"]) {
      state = value;
      expect(await reconcileQueuedJobs()).toBe(0);
    }
    expect(release).not.toHaveBeenCalled();
  });
  test("only confirmed completed or failed jobs release their reservations", async () => {
    for (const value of ["completed", "failed"]) {
      state = value;
      expect(await reconcileQueuedJobs()).toBe(1);
    }
    expect(release).toHaveBeenCalledTimes(2);
  });
});
