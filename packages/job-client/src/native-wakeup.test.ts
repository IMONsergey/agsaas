import { describe, expect, test } from "bun:test";
import { createNativeWakeup } from "./native-wakeup";

const request = {
  name: "sync-bank-connection" as const,
  payload: {
    connectionId: "11111111-1111-4111-8111-111111111111",
    teamId: "22222222-2222-4222-8222-222222222222",
  },
};
describe("durable operation wake-ups", () => {
  test("repeated reconciliation does not multiply a waiting job", async () => {
    let queued = 0;
    const wake = createNativeWakeup({
      find: async () => ({
        name: request.name,
        data: request.payload,
        getState: async () => "waiting",
        remove: async () => {
          throw new Error("must not remove live job");
        },
      }),
      enqueue: async () => {
        queued++;
      },
    });
    await wake(request);
    await wake(request);
    expect(queued).toBe(0);
  });
  test("completed owned jobs can wake the next SQL checkpoint", async () => {
    let removed = 0,
      queued = 0;
    const wake = createNativeWakeup({
      find: async () => ({
        name: request.name,
        data: request.payload,
        getState: async () => "completed",
        remove: async () => {
          removed++;
        },
      }),
      enqueue: async () => {
        queued++;
      },
    });
    await wake(request);
    expect(removed).toBe(1);
    expect(queued).toBe(1);
  });
  test("UUID letter case cannot multiply queue identities", async () => {
    const ids: string[] = [];
    const wake = createNativeWakeup({
      find: async () => undefined,
      enqueue: async (_request, id) => {
        ids.push(id);
      },
    });
    const connectionId = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    await wake({ ...request, payload: { ...request.payload, connectionId } });
    await wake({
      ...request,
      payload: { ...request.payload, connectionId: connectionId.toUpperCase() },
    });
    expect(ids[0]).toBe(ids[1]);
  });
  test("a foreign job collision is never removed", async () => {
    const wake = createNativeWakeup({
      find: async () => ({
        name: "foreign",
        data: request.payload,
        getState: async () => "completed",
        remove: async () => {
          throw new Error("must not remove foreign job");
        },
      }),
      enqueue: async () => undefined,
    });
    await expect(wake(request)).rejects.toThrow("identity conflict");
  });
  test("queue outage is visible to the reconciler and cannot pretend acceptance", async () => {
    const wake = createNativeWakeup({
      find: async () => undefined,
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
    });
    await expect(wake(request)).rejects.toThrow("queue unavailable");
  });
});
