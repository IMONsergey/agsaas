import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { reserveQueuedJobScript } from "./resource-admission";

const configured = process.env.TEST_REDIS_URL;
describe.skipIf(!configured)("queued job capacity (isolated Redis)", () => {
  let queue: Queue;
  const tag = randomUUID(),
    global = `agsaas:test:${tag}:global`,
    own = `agsaas:test:${tag}:team`;
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
      await client.del(global, own);
      await queue.close();
    }
  });
  test("atomic capacity handles competing enqueues and deduplicates identical jobs", async () => {
    const redis = await queue.client;
    const results = await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        redis.eval(
          reserveQueuedJobScript,
          2,
          global,
          own,
          `job-${index}`,
          Date.now(),
          200,
          2000,
        ),
      ),
    );
    expect(results.filter((value) => value === 1)).toHaveLength(200);
    expect(await redis.zcard(own)).toBe(200);
    const first = (await redis.zrange(own, 0, 0))[0]!;
    expect(
      await redis.eval(
        reserveQueuedJobScript,
        2,
        global,
        own,
        first,
        Date.now(),
        200,
        2000,
      ),
    ).toBe(1);
    expect(await redis.zcard(own)).toBe(200);
    await redis.zrem(global, first);
    await redis.zrem(own, first);
    expect(
      await redis.eval(
        reserveQueuedJobScript,
        2,
        global,
        own,
        "replacement",
        Date.now(),
        200,
        2000,
      ),
    ).toBe(1);
  });
});
