import { describe, expect, mock, test } from "bun:test";
import type { Queue } from "bullmq";
import { QueueManager } from "./queue-manager";
import { WorkbenchCore } from "./workbench";

describe("Workbench resource ownership", () => {
  test("manager closes its FlowProducer once, never caller-owned queues", async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queueClose = mock(async () => {});
    const manager = new QueueManager([
      { name: "fixture", opts: {}, close: queueClose } as unknown as Queue,
    ]);
    const producerClose = mock(() => drained);
    // No network connection: inject only the owned resource's close contract.
    Object.defineProperty(manager, "flowProducer", {
      value: { close: producerClose },
      writable: true,
    });
    const first = manager.close();
    expect(manager.close()).toBe(first);
    release();
    await first;
    expect(producerClose).toHaveBeenCalledTimes(1);
    expect(queueClose).not.toHaveBeenCalled();
  });

  test("manager exposes a close rejection without retrying or closing queues", async () => {
    const manager = new QueueManager([]);
    const close = mock(async () => {
      throw new Error("flow close failed");
    });
    Object.defineProperty(manager, "flowProducer", {
      value: { close },
      writable: true,
    });
    const closing = manager.close();
    await expect(closing).rejects.toThrow("flow close failed");
    expect(manager.close()).toBe(closing);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a manager without a producer closes without connecting", async () => {
    const manager = new QueueManager([]);
    await manager.close();
    await manager.close();
  });

  test("core forwards disposal to its queue manager", async () => {
    const core = new WorkbenchCore([{ name: "fixture", opts: {} } as Queue]);
    const closed = Promise.resolve();
    const close = mock(() => closed);
    core.queueManager.close = close;
    expect(core.close()).toBe(closed);
    await closed;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
