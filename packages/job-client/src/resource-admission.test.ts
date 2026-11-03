import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { parseQueuedJobReservation } from "./queued-admission-protocol";
import { runQueuedAdmissionCommand } from "./resource-admission";

const configured = process.env.TEST_REDIS_URL;
describe.skipIf(!configured)("queued job capacity (isolated Redis)", () => {
  let queue: Queue;
  const tag = randomUUID(),
    global = `agsaas:{admission-test-${tag}}:global`,
    own = `agsaas:{admission-test-${tag}}:team`;
  const raceGlobal = `${global}:race`,
    raceOwn = `${own}:race`;
  const keys = [global, own, `${global}:generations`, `${global}:retry`];
  const raceKeys = [
    raceGlobal,
    raceOwn,
    `${raceGlobal}:generations`,
    `${raceGlobal}:retry`,
  ];
  beforeAll(() => {
    const url = new URL(configured!);
    if (
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      !/^[1-9][0-9]*$/.test(url.pathname.slice(1))
    )
      throw new Error(
        "TEST_REDIS_URL must name a local, non-default disposable database",
      );
    queue = new Queue(`agsaas-admission-test-${tag}`, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: Number(url.pathname.slice(1)),
        username: url.username || undefined,
        password: url.password || undefined,
      },
    });
  });
  afterAll(async () => {
    if (queue) {
      const client = await queue.client;
      await client.del(...keys, ...raceKeys);
      await queue.close();
    }
  });
  test("atomic capacity handles competing enqueues and deduplicates identical jobs", async () => {
    const redis = await queue.client;
    const results = await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        runQueuedAdmissionCommand(redis, "reserve", keys, [
          `job-${index}`,
          Date.now(),
          200,
          2000,
          randomUUID(),
        ]),
      ),
    );
    expect(results.filter((value) => value === 1)).toHaveLength(200);
    expect(await redis.zcard(own)).toBe(200);
    const first = (await redis.zrange(own, 0, 0))[0]!;
    expect(
      await runQueuedAdmissionCommand(redis, "reserve", keys, [
        first,
        Date.now(),
        200,
        2000,
        randomUUID(),
      ]),
    ).toBe(1);
    expect(await redis.zcard(own)).toBe(200);
    const reservation = parseQueuedJobReservation(
      await runQueuedAdmissionCommand(redis, "capture", keys, [first]),
    );
    await runQueuedAdmissionCommand(redis, "release", keys, [
      first,
      reservation!.generation,
    ]);
    expect(
      await runQueuedAdmissionCommand(redis, "reserve", keys, [
        "replacement",
        Date.now(),
        200,
        2000,
        randomUUID(),
      ]),
    ).toBe(1);
  });
  test("reconciliation rotates only existing reservations and cannot resurrect a released job", async () => {
    const redis = await queue.client;
    expect(
      await runQueuedAdmissionCommand(redis, "reserve", raceKeys, [
        "race-job",
        10,
        2,
        2,
        randomUUID(),
      ]),
    ).toBe(1);
    await runQueuedAdmissionCommand(
      redis,
      "rotate",
      [raceGlobal],
      ["race-job", 20],
    );
    expect(await redis.zrange(raceGlobal, 0, -1, { WITHSCORES: true })).toEqual(
      ["race-job", "20"],
    );
    expect(await redis.zscore(raceOwn, "race-job")).toBe("10");
    // Simulate completion winning the race after reconciliation read the job.
    const reservation = parseQueuedJobReservation(
      await runQueuedAdmissionCommand(redis, "capture", raceKeys, ["race-job"]),
    );
    await runQueuedAdmissionCommand(redis, "release", raceKeys, [
      "race-job",
      reservation!.generation,
    ]);
    await runQueuedAdmissionCommand(
      redis,
      "rotate",
      [raceGlobal],
      ["race-job", 30],
    );
    expect(await redis.zscore(raceGlobal, "race-job")).toBeNull();
    expect(await redis.zscore(raceOwn, "race-job")).toBeNull();
  });
});
