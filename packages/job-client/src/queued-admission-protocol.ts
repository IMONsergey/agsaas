/** Keys always use the existing admission hash tag. Generation metadata fences
 * releases; it does not replace or reset either capacity sorted set. */
export const queuedAdmissionKeys = {
  global: "agsaas:{resource-admission}:queued",
  team: (teamId: string) => `agsaas:{resource-admission}:team:${teamId}`,
  generations: "agsaas:{resource-admission}:generations",
  retries: "agsaas:{resource-admission}:retry-intents",
};

export const queuedAdmissionLua = `
local function validGeneration(value)
  if type(value)~='string' or #value~=36 then return false end
  if value:sub(9,9)~='-' or value:sub(14,14)~='-' or value:sub(19,19)~='-' or value:sub(24,24)~='-' then return false end
  local compact=value:gsub('-','')
  return #compact==32 and compact:match('^[0-9a-f]+$')~=nil
end
local function validType(key,wanted)
  local actual=redis.call('TYPE',key).ok
  return actual=='none' or actual==wanted
end
local function admissionState(globalKey,teamKey,generationKey,retryKey,member)
  if not validType(globalKey,'zset') or not validType(teamKey,'zset') or
    not validType(generationKey,'hash') or not validType(retryKey,'hash') then return 'invalid' end
  local globalScore=redis.call('ZSCORE',globalKey,member)
  local teamScore=redis.call('ZSCORE',teamKey,member)
  local generation=redis.call('HGET',generationKey,member)
  local retry=redis.call('HGET',retryKey,member)
  if (globalScore and not teamScore) or (teamScore and not globalScore) then return 'invalid' end
  if not globalScore then
    if generation or retry then return 'invalid' end
    return 'missing'
  end
  if not generation then
    if retry then return 'invalid' end
    return 'reserved','legacy','none'
  end
  if not validGeneration(generation) then return 'invalid' end
  if not retry then return 'reserved',generation,'none' end
  if retry=='pending:'..generation then return 'reserved',generation,'pending' end
  if retry=='dispatched:'..generation then return 'reserved',generation,'dispatched' end
  return 'invalid'
end
`;

export const reserveQueuedJobScript = `${queuedAdmissionLua}
if not validGeneration(ARGV[5]) or not tonumber(ARGV[2]) or not tonumber(ARGV[3]) or not tonumber(ARGV[4]) then return -1 end
local state,generation,phase=admissionState(KEYS[1],KEYS[2],KEYS[3],KEYS[4],ARGV[1])
if state=='invalid' or phase=='pending' then return -1 end
if state=='reserved' then return 1 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) or redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[3]) then return 0 end
redis.call('ZADD',KEYS[1],ARGV[2],ARGV[1]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[1])
redis.call('HSET',KEYS[3],ARGV[1],ARGV[5]); return 1
`;

export const captureQueuedJobScript = `${queuedAdmissionLua}
local state,generation,phase=admissionState(KEYS[1],KEYS[2],KEYS[3],KEYS[4],ARGV[1])
if state~='reserved' or phase=='pending' then return {state,phase or ''} end
return {'reserved',generation,phase}
`;

export const captureWorkerQueuedJobScript = `${queuedAdmissionLua}
if not ARGV[2] or ARGV[2]=='' or not validType(KEYS[5],'string') or
  redis.call('GET',KEYS[5])~=ARGV[2] then return {'invalid','worker-lock'} end
local state,generation,phase=admissionState(KEYS[1],KEYS[2],KEYS[3],KEYS[4],ARGV[1])
if state~='reserved' or phase=='pending' then return {state,phase or ''} end
return {'reserved',generation,phase}
`;

const releaseReservationLua = `
local state,generation,phase=admissionState(KEYS[1],KEYS[2],KEYS[3],KEYS[4],ARGV[1])
if state=='missing' then return 0 end
if state~='reserved' or phase=='pending' then return -1 end
if generation~=ARGV[2] then return 0 end
redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1])
redis.call('HDEL',KEYS[3],ARGV[1]); redis.call('HDEL',KEYS[4],ARGV[1]); return 1
`;

export const releaseQueuedJobScript = `${queuedAdmissionLua}${releaseReservationLua}`;
export const releaseWorkerQueuedJobScript = `${queuedAdmissionLua}
if not validType(KEYS[5],'string') then return -1 end
if not ARGV[3] or ARGV[3]=='' or redis.call('GET',KEYS[5])~=ARGV[3] then return 0 end
${releaseReservationLua}`;

export type QueuedJobReservation = {
  generation: string;
  retry: "none" | "dispatched";
};

export function parseQueuedJobReservation(
  result: unknown,
): QueuedJobReservation | null {
  if (!Array.isArray(result))
    throw new Error("Invalid queued admission response");
  if (result[0] === "missing") return null;
  if (
    result[0] !== "reserved" ||
    typeof result[1] !== "string" ||
    !(
      result[1] === "legacy" ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        result[1],
      )
    ) ||
    !["none", "dispatched"].includes(result[2])
  ) {
    throw new Error(
      "Queued admission metadata requires operator reconciliation",
    );
  }
  return { generation: result[1], retry: result[2] };
}
