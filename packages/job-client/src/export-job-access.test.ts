import { beforeEach, describe, expect, mock, test } from "bun:test";

const team = "11111111-1111-4111-8111-111111111111";
let jobName = "export-team-data";
let jobTeam = team;
let resultReads = 0;
let progressReads = 0;
const getState = mock(async () => "completed");
const getJob = mock(async (_id: string) => ({
  name: jobName,
  data: { teamId: jobTeam },
  getState,
  get progress() {
    progressReads++;
    return 100;
  },
  get returnvalue() {
    resultReads++;
    return { fullPath: "private-full-team-path" };
  },
  failedReason: undefined,
}));
mock.module("./queues", () => ({
  getQueue: () => ({ getJob }),
  closeQueues: async () => {},
}));
mock.module("./resource-admission", () => ({
  captureQueuedJobReservation: async () => null,
  queuePayloadTeam: () => null,
  releaseQueuedJob: async () => {},
  reserveQueuedJob: async () => "not-used",
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({ warn() {}, info() {}, error() {} }),
}));
const { getJobStatus } = await import("./index");

beforeEach(() => {
  jobName = "export-team-data";
  jobTeam = team;
  resultReads = 0;
  progressReads = 0;
  getState.mockClear();
  getJob.mockClear();
});
describe("scoped export job status authorization", () => {
  test("known same-team full export ID cannot expose progress or return values", async () => {
    await expect(
      getJobStatus("transactions:known", {
        teamId: team,
        allowedJobNames: ["export-transactions", "export-to-accounting"],
      }),
    ).rejects.toThrow("Job not found or access denied");
    expect(getState).not.toHaveBeenCalled();
    expect(resultReads).toBe(0);
    expect(progressReads).toBe(0);
  });
  test("verified transaction export is readable within the explicit tool boundary", async () => {
    jobName = "export-transactions";
    expect(
      await getJobStatus("transactions:known", {
        teamId: team,
        allowedJobNames: ["export-transactions"],
      }),
    ).toMatchObject({ status: "completed", progress: 100 });
    expect(getState).toHaveBeenCalledTimes(1);
    expect(resultReads).toBe(1);
  });
  test("the name allowlist never bypasses team membership binding", async () => {
    jobName = "export-transactions";
    jobTeam = "22222222-2222-4222-8222-222222222222";
    await expect(
      getJobStatus("transactions:known", {
        teamId: team,
        allowedJobNames: ["export-transactions"],
      }),
    ).rejects.toThrow("Job not found or access denied");
    expect(resultReads).toBe(0);
  });
  test("an empty scope is closed while existing authenticated dashboard polling remains supported", async () => {
    await expect(
      getJobStatus("transactions:known", {
        teamId: team,
        allowedJobNames: [],
      }),
    ).rejects.toThrow("Job not found or access denied");
    expect(resultReads).toBe(0);
    expect(
      await getJobStatus("transactions:known", { teamId: team }),
    ).toMatchObject({
      status: "completed",
    });
    expect(resultReads).toBe(1);
  });
});
