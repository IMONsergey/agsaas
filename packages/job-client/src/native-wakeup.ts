import { triggerJob } from "./index";
import { getQueue } from "./queues";

type NativeWakeup =
  | {
      name: "sync-bank-connection";
      payload: { connectionId: string; teamId: string };
    }
  | {
      name: "deliver-onboarding";
      payload: { deliveryId: string; userId: string };
    };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type ExistingWakeup = {
  name: string;
  data: unknown;
  getState(): Promise<string>;
  remove(): Promise<void>;
};

export function createNativeWakeup(deps: {
  find: (id: string) => Promise<ExistingWakeup | undefined>;
  enqueue: (request: NativeWakeup, id: string) => Promise<unknown>;
}) {
  return async (input: NativeWakeup) => {
    if (!["sync-bank-connection", "deliver-onboarding"].includes(input.name))
      throw new Error("Invalid native job name");
    const values = Object.values(input.payload);
    const keys =
      input.name === "sync-bank-connection"
        ? ["connectionId", "teamId"]
        : ["deliveryId", "userId"];
    if (
      values.length !== 2 ||
      !keys.every((key) => key in input.payload) ||
      !values.every((value) => typeof value === "string" && uuid.test(value))
    )
      throw new Error("Invalid native job identity");
    const request = {
      name: input.name,
      payload: Object.fromEntries(
        Object.entries(input.payload).map(([key, value]) => [
          key,
          value.toLowerCase(),
        ]),
      ),
    } as NativeWakeup;
    const id =
      request.name === "sync-bank-connection"
        ? `native-bank-${request.payload.connectionId}`
        : `native-onboarding-${request.payload.deliveryId}`;
    const existing = await deps.find(id);
    if (existing) {
      const data = existing.data as Record<string, unknown> | null;
      if (
        existing.name !== request.name ||
        !data ||
        Object.keys(data).length !== 2 ||
        !Object.entries(request.payload).every(
          ([key, value]) => data[key] === value,
        )
      )
        throw new Error("Native job identity conflict");
      const state = await existing.getState();
      if (!["completed", "failed"].includes(state)) return { queued: false };
      try {
        await existing.remove();
      } catch {
        // Another reconciler may already have removed/replaced the same owned
        // terminal job. A live replacement should retain its single queue slot.
        if (await deps.find(id)) return { queued: false };
      }
    }
    await deps.enqueue(request, id);
    return { queued: true };
  };
}

/** One retained wake-up per durable SQL operation, including during outages.
 * terminal BullMQ jobs are replaced only after checking their exact identity.
 * Enqueue still passes through the shared resource-admission implementation. */
export const wakeNativeJob = createNativeWakeup({
  find: (id) => getQueue("teams").getJob(id),
  enqueue: (request, id) =>
    triggerJob(request.name, request.payload, "teams", {
      jobId: id,
      attempts: 1,
    }),
});
