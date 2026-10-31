import { describe, expect, mock, test } from "bun:test";
import { createQueueRegistry } from "./queue-registry";

describe("job-client queue ownership", () => {
  test("creates a queue lazily and reuses it by name", async () => {
    const factory = mock((name: string) => ({
      name,
      close: mock(async () => {}),
    }));
    const registry = createQueueRegistry(factory);
    expect(factory).not.toHaveBeenCalled();
    const queue = registry.getQueue("inbox");
    expect(registry.getQueue("inbox")).toBe(queue);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.getQueueNames()).toEqual(["inbox"]);
    await registry.closeQueues();
  });

  test("concurrent closes use one promise and close each owned queue once", async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closes: string[] = [];
    const registry = createQueueRegistry((name) => ({
      close: async () => {
        closes.push(name);
        await drained;
      },
    }));
    registry.getQueue("inbox");
    registry.getQueue("documents");
    const first = registry.closeQueues();
    const second = registry.closeQueues();
    expect(second).toBe(first);
    expect(registry.getQueueNames()).toEqual([]);
    expect(() => registry.getQueue("inbox")).toThrow("closing");
    expect(() => registry.getQueue("new-queue")).toThrow("closing");
    release();
    await first;
    expect(closes.sort()).toEqual(["documents", "inbox"]);
    expect(registry.closeQueues()).toBe(first);
  });

  test("one synchronous close failure does not skip other queues", async () => {
    const closed: string[] = [];
    const registry = createQueueRegistry((name) => ({
      close: () => {
        closed.push(name);
        if (name === "broken") throw new Error("close failed");
        return Promise.resolve();
      },
    }));
    registry.getQueue("broken");
    registry.getQueue("healthy");
    const closing = registry.closeQueues();
    await expect(closing).rejects.toThrow(AggregateError);
    expect(closed.sort()).toEqual(["broken", "healthy"]);
    expect(registry.closeQueues()).toBe(closing);
  });

  test("an empty registry closes without creating any connection", async () => {
    const factory = mock(() => ({ close: async () => {} }));
    const registry = createQueueRegistry(factory);
    await registry.closeQueues();
    expect(factory).not.toHaveBeenCalled();
    expect(() => registry.getQueue("late")).toThrow("closing");
  });
});
