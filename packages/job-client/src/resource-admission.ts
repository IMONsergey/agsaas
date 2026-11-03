import { randomUUID } from "node:crypto";
import type { IRedisClient } from "bullmq";
import {
  captureQueuedJobScript,
  captureWorkerQueuedJobScript,
  parseQueuedJobReservation,
  queuedAdmissionKeys,
  releaseQueuedJobScript,
  releaseWorkerQueuedJobScript,
  reserveQueuedJobScript,
} from "./queued-admission-protocol";
import { getQueue } from "./queues";

export { reserveQueuedJobScript } from "./queued-admission-protocol";

const globalKey = queuedAdmissionKeys.global;
const teamKey = queuedAdmissionKeys.team;
function admissionKeys(teamId: string) {
  return [
    globalKey,
    teamKey(teamId),
    queuedAdmissionKeys.generations,
    queuedAdmissionKeys.retries,
  ];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class QueueCapacityError extends Error {
  constructor() {
    super(
      "Too many jobs are queued for this workspace. Retry after existing jobs complete.",
    );
    this.name = "QueueCapacityError";
  }
}
export function queuePayloadTeam(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const teamId = (payload as { teamId?: unknown }).teamId;
  return typeof teamId === "string" && uuid.test(teamId)
    ? teamId.toLowerCase()
    : null;
}
const commands = {
  reserve: {
    name: "agsaasReserveQueuedJobV2",
    numberOfKeys: 4,
    lua: reserveQueuedJobScript,
  },
  release: {
    name: "agsaasReleaseQueuedJobV2",
    numberOfKeys: 4,
    lua: releaseQueuedJobScript,
  },
  releaseWorker: {
    name: "agsaasReleaseWorkerQueuedJobV2",
    numberOfKeys: 5,
    lua: releaseWorkerQueuedJobScript,
  },
  capture: {
    name: "agsaasCaptureQueuedJobV2",
    numberOfKeys: 4,
    lua: captureQueuedJobScript,
  },
  captureWorker: {
    name: "agsaasCaptureWorkerQueuedJobV2",
    numberOfKeys: 5,
    lua: captureWorkerQueuedJobScript,
  },
  rotate: {
    name: "agsaasRotateQueuedJobV1",
    numberOfKeys: 1,
    // A concurrent completion may release the reservation after reconciliation
    // reads it. XX rotates an existing member without recreating an orphan.
    lua: "return redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])",
  },
} as const;
const registeredClients = new WeakSet<IRedisClient>();

/** BullMQ's public adapter contract supports named Lua commands across Redis
 * clients; raw ioredis eval/zadd methods are not part of that contract. */
export function runQueuedAdmissionCommand(
  client: IRedisClient,
  command: keyof typeof commands,
  keys: string[],
  args: Array<string | number>,
): Promise<unknown> {
  const definition = commands[command];
  if (keys.length !== definition.numberOfKeys)
    throw new Error("Invalid admission command keys");
  if (!registeredClients.has(client)) {
    for (const { name, numberOfKeys, lua } of Object.values(commands)) {
      client.defineCommand(name, { numberOfKeys, lua });
    }
    registeredClients.add(client);
  }
  return client.runCommand(definition.name, [...keys, ...args]);
}

export async function reserveQueuedJob(
  queueName: string,
  payload: unknown,
  requestedId?: string,
  jobName?: string,
) {
  const serialized = JSON.stringify(payload);
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized) > 5 * 1024 * 1024
  )
    throw new Error("Job payload exceeds 5 MiB");
  const teamId = queuePayloadTeam(payload);
  const id = requestedId ?? randomUUID();
  if (!teamId) return id; // trusted global schedulers are separately bounded by their batch sizes
  const member = JSON.stringify({ teamId, queueName, id });
  if (Buffer.byteLength(member) > 4096)
    throw new Error("Job identity is too large");
  const redis = await getQueue(queueName).client;
  // Reserve headroom for child jobs awaited by admitted parents, avoiding a full-queue deadlock.
  const continuation =
    ["classify-document", "classify-image", "embed-document-tags"].includes(
      jobName ?? "",
    ) || queueName === "emails";
  const admitted = await runQueuedAdmissionCommand(
    redis,
    "reserve",
    admissionKeys(teamId),
    [
      member,
      Date.now(),
      continuation ? 200 : 160,
      continuation ? 2000 : 1600,
      randomUUID(),
    ],
  );
  if (admitted === 0) throw new QueueCapacityError();
  if (admitted !== 1)
    throw new Error(
      "Queued admission metadata requires operator reconciliation",
    );
  return id;
}

/** Capture before processing or observing terminal state, never after it. A
 * later retry changes generation so this observer cannot release its slot. */
export async function captureQueuedJobReservation(
  queueName: string,
  id: string,
  teamId: string,
) {
  if (!uuid.test(teamId)) throw new Error("Invalid queued admission team");
  const team = teamId.toLowerCase();
  const client = await getQueue(queueName).client;
  return parseQueuedJobReservation(
    await runQueuedAdmissionCommand(client, "capture", admissionKeys(team), [
      JSON.stringify({ teamId: team, queueName, id }),
    ]),
  );
}

export async function captureWorkerQueuedJobReservation(
  queueName: string,
  id: string,
  teamId: string,
  token: string | undefined,
) {
  if (!uuid.test(teamId) || !token)
    throw new Error("Active worker admission requires its BullMQ lock");
  const team = teamId.toLowerCase();
  const queue = getQueue(queueName);
  return parseQueuedJobReservation(
    await runQueuedAdmissionCommand(
      await queue.client,
      "captureWorker",
      [...admissionKeys(team), `${queue.toKey(id)}:lock`],
      [JSON.stringify({ teamId: team, queueName, id }), token],
    ),
  );
}

export async function releaseQueuedJob(
  queueName: string,
  id: string,
  teamId: string,
  generation: string,
) {
  if (!uuid.test(teamId)) return;
  const normalizedTeam = teamId.toLowerCase();
  const redis = await getQueue(queueName).client;
  const member = JSON.stringify({ teamId: normalizedTeam, queueName, id });
  const released = await runQueuedAdmissionCommand(
    redis,
    "release",
    admissionKeys(normalizedTeam),
    [member, generation],
  );
  if (released !== 0 && released !== 1)
    throw new Error("Queued admission release requires reconciliation");
  return released === 1;
}

/** Automatic stalled takeover keeps the reservation generation. The worker's
 * current Redis lock must therefore still match at release, not only capture. */
export async function releaseWorkerQueuedJobReservation(
  queueName: string,
  id: string,
  teamId: string,
  generation: string,
  token: string | undefined,
) {
  if (!uuid.test(teamId) || !token) return false;
  const team = teamId.toLowerCase();
  const queue = getQueue(queueName);
  const released = await runQueuedAdmissionCommand(
    await queue.client,
    "releaseWorker",
    [...admissionKeys(team), `${queue.toKey(id)}:lock`],
    [JSON.stringify({ teamId: team, queueName, id }), generation, token],
  );
  if (released !== 0 && released !== 1)
    throw new Error("Worker admission release requires reconciliation");
  return released === 1;
}

/** Only a confirmed terminal job releases its reservation automatically.
 * A missing job may still be enqueued by a suspended producer or buffered Redis
 * write. Age is a polling threshold, never proof that this producer has stopped. */
export async function reconcileQueuedJobs() {
  const redis = await getQueue("teams").client;
  const members = await redis.zrange(globalKey, 0, 99, { WITHSCORES: true });
  let released = 0;
  for (let i = 0; i < members.length; i += 2) {
    const text = members[i]!,
      createdAt = Number(members[i + 1]);
    if (Date.now() - createdAt < 10 * 60_000) continue;
    try {
      const value = JSON.parse(text) as {
        teamId: string;
        queueName: string;
        id: string;
      };
      if (
        !uuid.test(value.teamId) ||
        typeof value.queueName !== "string" ||
        typeof value.id !== "string"
      )
        continue;
      const reservation = await captureQueuedJobReservation(
        value.queueName,
        value.id,
        value.teamId,
      );
      if (!reservation) continue;
      const job = await getQueue(value.queueName).getJob(value.id);
      const state = job ? await job.getState() : "missing";
      if (["completed", "failed"].includes(state)) {
        if (
          await releaseQueuedJob(
            value.queueName,
            value.id,
            value.teamId,
            reservation.generation,
          )
        )
          released++;
      } else
        await runQueuedAdmissionCommand(
          redis,
          "rotate",
          [globalKey],
          [text, Date.now()],
        ); // rotate live jobs so old failures are not starved
    } catch {
      // Retain uncertain slots but let the next bounded scan reach other jobs.
      await runQueuedAdmissionCommand(
        redis,
        "rotate",
        [globalKey],
        [text, Date.now()],
      ).catch(() => {});
    }
  }
  return released;
}

/** Backend/operator inventory; no payload, credentials, or personal content. */
export async function inspectQueuedReservations(limit = 100) {
  const redis = await getQueue("teams").client;
  const members = await redis.zrange(
    globalKey,
    0,
    Math.min(Math.max(Math.trunc(limit), 1), 100) - 1,
    { WITHSCORES: true },
  );
  const output: Array<{
    teamId: string;
    queueName: string;
    id: string;
    lastCheckedAt: number;
    state: string;
    admission: string;
  }> = [];
  for (let index = 0; index < members.length; index += 2) {
    try {
      const value = JSON.parse(members[index]!) as {
        teamId: string;
        queueName: string;
        id: string;
      };
      if (
        !uuid.test(value.teamId) ||
        typeof value.queueName !== "string" ||
        typeof value.id !== "string"
      )
        continue;
      const metadata = await runQueuedAdmissionCommand(
        redis,
        "capture",
        admissionKeys(value.teamId.toLowerCase()),
        [members[index]!],
      );
      const admission = Array.isArray(metadata)
        ? metadata[0] === "reserved" && metadata[2]
          ? String(metadata[2])
          : String(metadata[1] || metadata[0])
        : "invalid";
      const job = await getQueue(value.queueName).getJob(value.id);
      output.push({
        ...value,
        lastCheckedAt: Number(members[index + 1]),
        state: job ? await job.getState() : "missing-unconfirmed",
        admission,
      });
    } catch {
      /* ambiguous/malformed entries remain reserved */
    }
  }
  return output;
}
