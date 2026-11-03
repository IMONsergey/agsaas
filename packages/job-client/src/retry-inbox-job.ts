import { createHash, randomUUID } from "node:crypto";
import type { IRedisClient, Job } from "bullmq";
import { reprocessJob } from "bullmq/dist/esm/scripts/reprocessJob-8.js";
import { version as bullmqVersion } from "bullmq/dist/esm/version.js";
import {
  queuedAdmissionKeys,
  queuedAdmissionLua,
} from "./queued-admission-protocol";
import { getQueue } from "./queues";
import { QueueCapacityError, queuePayloadTeam } from "./resource-admission";

const NATIVE_SHA256 =
  "33f68fa67b8418597ed1b941a48b3079ccf8fbda229cfb6ec9f2509501f069be";
export type InboxRetrySnapshot = {
  finishedOn: number;
  attemptsMade: number;
  attemptsStarted: number;
  dataJson: string;
  lifo: boolean;
};

export function inboxRetrySnapshot(
  job: Pick<
    Job,
    "finishedOn" | "attemptsMade" | "attemptsStarted" | "data" | "opts"
  >,
): InboxRetrySnapshot {
  if (
    !Number.isSafeInteger(job.finishedOn) ||
    !job.finishedOn ||
    !Number.isSafeInteger(job.attemptsMade) ||
    job.attemptsMade < 0 ||
    !Number.isSafeInteger(job.attemptsStarted) ||
    job.attemptsStarted < 0 ||
    job.opts.parent
  ) {
    throw new Error("Invalid retained Inbox retry snapshot");
  }
  return {
    finishedOn: job.finishedOn,
    attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted,
    dataJson: JSON.stringify(job.data),
    lifo: job.opts.lifo === true,
  };
}

/** Import the installed upstream operation instead of maintaining a copied
 * implementation. Any package/script change requires another protocol review. */
export function createAdmittedInboxRetryScript() {
  if (
    bullmqVersion !== "5.81.5" ||
    reprocessJob.name !== "reprocessJob" ||
    reprocessJob.keys !== 8 ||
    createHash("sha256").update(reprocessJob.content).digest("hex") !==
      NATIVE_SHA256
  ) {
    throw new Error(
      "BullMQ retry implementation is outside its reviewed admission contract",
    );
  }
  return `${queuedAdmissionLua}
local function nativeRetry()
${reprocessJob.content}
end
-- Native keys 1..8; admission global/team/generations/retries 9..12.
-- Native args 1..6; member,generation,now,team/global limits 7..11;
-- observed finishedOn/attemptsMade/attemptsStarted/data 12..15.
-- Validate every referenced key and native branch before any mutation. Lua
-- errors do not roll back previous writes: the pending marker retains a slot.
local expectedTypes={'hash','stream','zset','list','hash','list','list','zset'}
for i,wanted in ipairs(expectedTypes) do
  if not validType(KEYS[i],wanted) then return {'refused','native-key-type'} end
end
if not validGeneration(ARGV[8]) or not tonumber(ARGV[9]) or
  not tonumber(ARGV[10]) or not tonumber(ARGV[11]) then return {'refused','arguments'} end
if ARGV[4]~='failed' or ARGV[3]~='failedReason' or ARGV[5]~='0' or ARGV[6]~='0' or
  (ARGV[2]~='LPUSH' and ARGV[2]~='RPUSH') then return {'refused','native-arguments'} end
if redis.call('EXISTS',KEYS[1])~=1 or not redis.call('ZSCORE',KEYS[3],ARGV[1]) then return {'stale','state'} end
local values=redis.call('HMGET',KEYS[1],'name','data','finishedOn','atm','ats','opts','parentKey')
if values[1]~='process-attachment' or values[2]~=ARGV[15] or values[3]~=ARGV[12] or
  (values[4] or '0')~=ARGV[13] or (values[5] or '0')~=ARGV[14] or values[7] then return {'stale','identity'} end
if redis.call('EXISTS',KEYS[1]..':lock')~=0 then return {'refused','locked'} end
local decoded,options=pcall(cjson.decode,values[6] or '')
if not decoded or type(options)~='table' or options.parent or
  (options.lifo and ARGV[2]~='RPUSH') or (not options.lifo and ARGV[2]~='LPUSH') then return {'refused','options'} end
local maxEvents=redis.call('HGET',KEYS[5],'opts.maxLenEvents')
local concurrency=redis.call('HGET',KEYS[5],'concurrency')
local function validNativeInteger(value)
  return value:match('^[1-9][0-9]*$')~=nil and tonumber(value) and tonumber(value)<=9007199254740991
end
if (maxEvents and not validNativeInteger(maxEvents)) or
  (concurrency and not validNativeInteger(concurrency)) then return {'refused','native-meta'} end
local state,generation,phase=admissionState(KEYS[9],KEYS[10],KEYS[11],KEYS[12],ARGV[7])
if state=='invalid' or phase=='pending' then return {'refused','admission-metadata'} end
if state=='missing' and (redis.call('ZCARD',KEYS[9])>=tonumber(ARGV[11]) or
  redis.call('ZCARD',KEYS[10])>=tonumber(ARGV[10])) then return {'capacity'} end
-- Reservation precedes every potentially runnable queue mutation. If Redis
-- reports an exceptional native error, this pending generation stays fenced.
redis.call('ZADD',KEYS[9],ARGV[9],ARGV[7]); redis.call('ZADD',KEYS[10],ARGV[9],ARGV[7])
redis.call('HSET',KEYS[11],ARGV[7],ARGV[8]); redis.call('HSET',KEYS[12],ARGV[7],'pending:'..ARGV[8])
local result=nativeRetry()
if result~=1 then return {'refused','native-result'} end
redis.call('HSET',KEYS[12],ARGV[7],'dispatched:'..ARGV[8])
return {'retried',ARGV[8]}
`;
}

const registered = new WeakSet<IRedisClient>();
const commandName = "agsaasRetryInboxWithAdmissionV1";

/** Exported for a real isolated Redis gate using only that gate's private keys. */
export async function runAdmittedInboxRetry(
  client: IRedisClient,
  input: {
    keys: string[];
    id: string;
    member: string;
    snapshot: InboxRetrySnapshot;
    generation?: string;
    now?: number;
    teamLimit?: number;
    globalLimit?: number;
  },
) {
  if (input.keys.length !== 12) throw new Error("Invalid admitted retry keys");
  const { snapshot } = input;
  if (
    !Number.isSafeInteger(snapshot.finishedOn) ||
    snapshot.finishedOn < 1 ||
    !Number.isSafeInteger(snapshot.attemptsMade) ||
    snapshot.attemptsMade < 0 ||
    !Number.isSafeInteger(snapshot.attemptsStarted) ||
    snapshot.attemptsStarted < 0 ||
    typeof snapshot.dataJson !== "string" ||
    Buffer.byteLength(snapshot.dataJson) > 5 * 1024 * 1024
  ) {
    throw new Error("Invalid admitted retry snapshot");
  }
  if (!registered.has(client)) {
    client.defineCommand(commandName, {
      numberOfKeys: 12,
      lua: createAdmittedInboxRetryScript(),
    });
    registered.add(client);
  }
  const result = await client.runCommand(commandName, [
    ...input.keys,
    input.id,
    snapshot.lifo ? "RPUSH" : "LPUSH",
    "failedReason",
    "failed",
    "0",
    "0",
    input.member,
    input.generation ?? randomUUID(),
    input.now ?? Date.now(),
    input.teamLimit ?? 160,
    input.globalLimit ?? 1600,
    String(snapshot.finishedOn),
    String(snapshot.attemptsMade),
    String(snapshot.attemptsStarted),
    snapshot.dataJson,
  ]);
  if (!Array.isArray(result))
    throw new Error("Invalid admitted retry response");
  if (result[0] === "capacity") throw new QueueCapacityError();
  if (result[0] === "stale") return { retried: false as const };
  if (result[0] !== "retried" || typeof result[1] !== "string") {
    throw new Error("Inbox retry requires operator reconciliation");
  }
  return { retried: true as const, generation: result[1] };
}

export async function retryInboxJobWithAdmission(
  id: string,
  payload: unknown,
  snapshot: InboxRetrySnapshot,
) {
  const teamId = queuePayloadTeam(payload);
  if (!teamId || !/^postmark-receipt_[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid Inbox retry identity");
  if (JSON.stringify(payload) !== snapshot.dataJson)
    throw new Error("Inbox retry payload changed");
  const queue = getQueue("inbox");
  return runAdmittedInboxRetry(await queue.client, {
    id,
    snapshot,
    member: JSON.stringify({ teamId, queueName: "inbox", id }),
    keys: [
      queue.toKey(id),
      queue.keys.events!,
      queue.toKey("failed"),
      queue.keys.wait!,
      queue.keys.meta!,
      queue.keys.paused!,
      queue.keys.active!,
      queue.keys.marker!,
      queuedAdmissionKeys.global,
      queuedAdmissionKeys.team(teamId),
      queuedAdmissionKeys.generations,
      queuedAdmissionKeys.retries,
    ],
  });
}
