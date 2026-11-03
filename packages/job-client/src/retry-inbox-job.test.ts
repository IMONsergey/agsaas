import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Job, Queue, QueueEvents, Worker } from "bullmq";
import { parseQueuedJobReservation } from "./queued-admission-protocol";
import { runQueuedAdmissionCommand } from "./resource-admission";
import { inboxRetrySnapshot, runAdmittedInboxRetry } from "./retry-inbox-job";

const configured = process.env.TEST_REDIS_URL;
describe.skipIf(!configured)("admitted Inbox retry (isolated Redis)", () => {
  const tag = randomUUID();
  const teamId = randomUUID();
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker;
  const ownedMetadata = new Set<string>();
  beforeAll(async () => {
    const url = new URL(configured!);
    if (
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      !/^[1-9][0-9]*$/.test(url.pathname.slice(1))
    ) {
      throw new Error(
        "TEST_REDIS_URL must name a local non-default disposable database",
      );
    }
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      db: Number(url.pathname.slice(1)),
      username: url.username || undefined,
      password: url.password || undefined,
      maxRetriesPerRequest: null,
    };
    const name = `agsaas-retry-test-${tag}`;
    queue = new Queue(name, { connection });
    events = new QueueEvents(name, { connection });
    worker = new Worker(
      name,
      async () => {
        throw new Error("intentional fixture failure");
      },
      { connection },
    );
    worker.on("error", () => {});
    await Promise.all([
      queue.waitUntilReady(),
      events.waitUntilReady(),
      worker.waitUntilReady(),
    ]);
    await worker.pause();
  });
  afterAll(async () => {
    if (worker) await worker.close();
    if (events) await events.close();
    if (queue) {
      if (ownedMetadata.size) await (await queue.client).del(...ownedMetadata);
      // Only this random, newly created fixture queue; no global Redis flush.
      await queue.obliterate();
      await queue.close();
    }
  });

  async function failedJob() {
    const id = randomUUID();
    const keys = [
      `agsaas:{retry-test-${tag}}:${id}:global`,
      `agsaas:{retry-test-${tag}}:${id}:team`,
      `agsaas:{retry-test-${tag}}:${id}:generation`,
      `agsaas:{retry-test-${tag}}:${id}:retry`,
    ];
    for (const key of keys) ownedMetadata.add(key);
    const member = JSON.stringify({ teamId, queueName: queue.name, id });
    const oldGeneration = randomUUID();
    const client = await queue.client;
    expect(
      await runQueuedAdmissionCommand(client, "reserve", keys, [
        member,
        1,
        2,
        2,
        oldGeneration,
      ]),
    ).toBe(1);
    const job = await queue.add(
      "process-attachment",
      {
        teamId,
        referenceId: `fixture-${id}`,
        filePath: [teamId, "inbox", "uploads", `${id}.bin`],
        size: 8,
        mimetype: "application/pdf",
      },
      { jobId: id, attempts: 1, removeOnFail: false, removeOnComplete: false },
    );
    const outcome = job.waitUntilFinished(events, 5_000).catch(() => "failed");
    worker.resume();
    expect(await outcome).toBe("failed");
    await worker.pause();
    const retained = await Job.fromId(queue, id);
    expect(await retained!.getState()).toBe("failed");
    const snapshot = inboxRetrySnapshot(retained!);
    const nativeKeys = [
      queue.toKey(id),
      queue.keys.events!,
      queue.toKey("failed"),
      queue.keys.wait!,
      queue.keys.meta!,
      queue.keys.paused!,
      queue.keys.active!,
      queue.keys.marker!,
    ];
    const input = {
      id,
      member,
      snapshot,
      keys: [...nativeKeys, ...keys],
      teamLimit: 2,
      globalLimit: 2,
    };
    return {
      id,
      member,
      keys,
      oldGeneration,
      client,
      input,
      snapshot,
      retained: retained!,
    };
  }

  test("atomic retry has one slot, a new generation, and a runnable native job", async () => {
    const f = await failedJob();
    const outcome = await runAdmittedInboxRetry(f.client, f.input);
    expect(outcome.retried).toBe(true);
    const reservation = parseQueuedJobReservation(
      await runQueuedAdmissionCommand(f.client, "capture", f.keys, [f.member]),
    );
    expect(reservation!.generation).not.toBe(f.oldGeneration);
    expect(reservation!.retry).toBe("dispatched");
    expect(await f.client.zcard(f.keys[0]!)).toBe(1);
    expect(await f.retained.getState()).toBe("waiting");
  });

  test("competing identical retries transition once and retain the same generation", async () => {
    const f = await failedJob();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        runAdmittedInboxRetry(f.client, f.input),
      ),
    );
    expect(outcomes.filter((value) => value.retried)).toHaveLength(1);
    expect(
      (await f.client.lrange(queue.keys.wait!, 0, -1)).filter(
        (id) => id === f.id,
      ),
    ).toHaveLength(1);
    expect(await f.client.zcard(f.keys[0]!)).toBe(1);
  });

  test("old worker and reconciler releases cannot remove the new retry slot", async () => {
    const f = await failedJob();
    await runAdmittedInboxRetry(f.client, f.input);
    expect(
      await runQueuedAdmissionCommand(f.client, "release", f.keys, [
        f.member,
        f.oldGeneration,
      ]),
    ).toBe(0);
    expect(await f.client.zcard(f.keys[0]!)).toBe(1);
    const current = parseQueuedJobReservation(
      await runQueuedAdmissionCommand(f.client, "capture", f.keys, [f.member]),
    );
    const completion = f.retained
      .waitUntilFinished(events, 5_000)
      .catch(() => "failed");
    worker.resume();
    await completion;
    await worker.pause();
    expect(
      await runQueuedAdmissionCommand(f.client, "release", f.keys, [
        f.member,
        current!.generation,
      ]),
    ).toBe(1);
    expect(await f.client.hget(f.keys[2]!, f.member)).toBeNull();
    expect(await f.client.hget(f.keys[3]!, f.member)).toBeNull();
  });

  test("a stale worker lock cannot capture a replacement generation", async () => {
    const f = await failedJob();
    await runAdmittedInboxRetry(f.client, f.input);
    const lockKey = `${queue.toKey(f.id)}:lock`;
    await f.client.set(lockKey, "new-fixture-lock");
    try {
      const stale = await runQueuedAdmissionCommand(
        f.client,
        "captureWorker",
        [...f.keys, lockKey],
        [f.member, "old-fixture-lock"],
      );
      expect(() => parseQueuedJobReservation(stale)).toThrow();
      expect(
        parseQueuedJobReservation(
          await runQueuedAdmissionCommand(
            f.client,
            "captureWorker",
            [...f.keys, lockKey],
            [f.member, "new-fixture-lock"],
          ),
        )!.retry,
      ).toBe("dispatched");
    } finally {
      await f.client.del(lockKey);
    }
  });

  test("a suspended old producer cannot retry a later failed attempt", async () => {
    const f = await failedJob();
    await runAdmittedInboxRetry(f.client, f.input);
    const completion = f.retained
      .waitUntilFinished(events, 5_000)
      .catch(() => "failed");
    worker.resume();
    await completion;
    await worker.pause();
    const current = await Job.fromId(queue, f.id);
    expect(current!.attemptsMade).toBeGreaterThan(f.snapshot.attemptsMade);
    const before = await f.client.hget(f.keys[2]!, f.member);
    expect((await runAdmittedInboxRetry(f.client, f.input)).retried).toBe(
      false,
    );
    expect(await f.retained.getState()).toBe("failed");
    expect(await f.client.hget(f.keys[2]!, f.member)).toBe(before);
  });

  test("stalled takeover with the same generation fences the old worker's release", async () => {
    const f = await failedJob();
    const lockKey = `${queue.toKey(f.id)}:lock`;
    await f.client.set(lockKey, "old-fixture-lock");
    const captured = parseQueuedJobReservation(
      await runQueuedAdmissionCommand(
        f.client,
        "captureWorker",
        [...f.keys, lockKey],
        [f.member, "old-fixture-lock"],
      ),
    );
    await f.client.set(lockKey, "takeover-fixture-lock");
    try {
      expect(
        await runQueuedAdmissionCommand(
          f.client,
          "releaseWorker",
          [...f.keys, lockKey],
          [f.member, captured!.generation, "old-fixture-lock"],
        ),
      ).toBe(0);
      expect(await f.client.zcard(f.keys[0]!)).toBe(1);
      expect(await f.client.hget(f.keys[2]!, f.member)).toBe(
        captured!.generation,
      );
      expect(
        await runQueuedAdmissionCommand(
          f.client,
          "releaseWorker",
          [...f.keys, lockKey],
          [f.member, captured!.generation, "takeover-fixture-lock"],
        ),
      ).toBe(1);
    } finally {
      await f.client.del(lockKey);
    }
  });

  test("a lost retry response is recoverable without a second transition", async () => {
    const f = await failedJob();
    await runAdmittedInboxRetry(f.client, f.input); // Discard the first response.
    expect((await runAdmittedInboxRetry(f.client, f.input)).retried).toBe(
      false,
    );
    expect(await f.retained.getState()).toBe("waiting");
    expect(await f.client.zcard(f.keys[0]!)).toBe(1);
  });

  test("capacity refusal leaves the failed receipt and queue untouched", async () => {
    const f = await failedJob();
    await runQueuedAdmissionCommand(f.client, "release", f.keys, [
      f.member,
      f.oldGeneration,
    ]);
    for (const member of ["other-1", "other-2"])
      await runQueuedAdmissionCommand(f.client, "reserve", f.keys, [
        member,
        1,
        2,
        2,
        randomUUID(),
      ]);
    await expect(runAdmittedInboxRetry(f.client, f.input)).rejects.toThrow(
      "Too many jobs",
    );
    expect(await f.retained.getState()).toBe("failed");
    expect(await f.client.zscore(f.keys[0]!, f.member)).toBeNull();
  });

  test("changed payload and native type drift are refused before mutation", async () => {
    const f = await failedJob();
    expect(
      (
        await runAdmittedInboxRetry(f.client, {
          ...f.input,
          snapshot: { ...f.snapshot, dataJson: "{}" },
        })
      ).retried,
    ).toBe(false);
    const wrongKey = `${f.keys[0]}:wrong-native-key`;
    ownedMetadata.add(wrongKey);
    await f.client.set(wrongKey, "wrong type");
    const keys = [...f.input.keys];
    keys[1] = wrongKey;
    await expect(
      runAdmittedInboxRetry(f.client, { ...f.input, keys }),
    ).rejects.toThrow();
    expect(await f.retained.getState()).toBe("failed");
    expect(await f.client.hget(f.keys[2]!, f.member)).toBe(f.oldGeneration);
  });

  test("pending and malformed metadata retain capacity and block release/retry", async () => {
    const f = await failedJob();
    for (const marker of [`pending:${f.oldGeneration}`, "unknown-marker"]) {
      await f.client.hset(f.keys[3]!, { [f.member]: marker });
      const metadata = await runQueuedAdmissionCommand(
        f.client,
        "capture",
        f.keys,
        [f.member],
      );
      expect(() => parseQueuedJobReservation(metadata)).toThrow();
      expect(
        await runQueuedAdmissionCommand(f.client, "release", f.keys, [
          f.member,
          f.oldGeneration,
        ]),
      ).toBe(-1);
      await expect(runAdmittedInboxRetry(f.client, f.input)).rejects.toThrow();
      expect(await f.client.zcard(f.keys[0]!)).toBe(1);
      expect(await f.retained.getState()).toBe("failed");
    }
  });
});
