import { randomUUID } from "node:crypto";
import { getQueue } from "./queues";

const globalKey = "agsaas:{resource-admission}:queued";
const teamKey = (teamId: string) =>
  `agsaas:{resource-admission}:team:${teamId}`;
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
export const reserveQueuedJobScript = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1]); redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1]); return 1`;

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
  const admitted = await redis.eval(
    reserveQueuedJobScript,
    2,
    globalKey,
    teamKey(teamId),
    member,
    Date.now(),
    continuation ? 200 : 160,
    continuation ? 2000 : 1600,
  );
  if (admitted !== 1) throw new QueueCapacityError();
  return id;
}

export async function releaseQueuedJob(
  queueName: string,
  id: string,
  teamId: string,
) {
  if (!uuid.test(teamId)) return;
  const redis = await getQueue(queueName).client;
  const member = JSON.stringify({ teamId, queueName, id });
  await redis.eval(
    "redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1]); return 1",
    2,
    globalKey,
    teamKey(teamId),
    member,
  );
}

/** Only a confirmed terminal job releases its reservation automatically.
 * A missing job may still be enqueued by a suspended producer or buffered Redis
 * write. Age is a polling threshold, never proof that this producer has stopped. */
export async function reconcileQueuedJobs() {
  const redis = await getQueue("teams").client;
  const members = await redis.zrange(globalKey, 0, 99, "WITHSCORES");
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
      const job = await getQueue(value.queueName).getJob(value.id);
      const state = job ? await job.getState() : "missing";
      if (["completed", "failed"].includes(state)) {
        await releaseQueuedJob(value.queueName, value.id, value.teamId);
        released++;
      } else await redis.zadd(globalKey, Date.now(), text); // rotate live jobs so old failures are not starved
    } catch {
      /* keep ambiguous reservations */
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
    "WITHSCORES",
  );
  const output: Array<{
    teamId: string;
    queueName: string;
    id: string;
    lastCheckedAt: number;
    state: string;
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
      const job = await getQueue(value.queueName).getJob(value.id);
      output.push({
        ...value,
        lastCheckedAt: Number(members[index + 1]),
        state: job ? await job.getState() : "missing-unconfirmed",
      });
    } catch {
      /* ambiguous/malformed entries remain reserved */
    }
  }
  return output;
}
