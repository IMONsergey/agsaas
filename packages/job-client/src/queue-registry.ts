type ClosableQueue = { close(): Promise<unknown> };

/** Own only the lazily created enqueueing queues, never Worker instances. */
export function createQueueRegistry<Queue extends ClosableQueue>(
  createQueue: (name: string) => Queue,
) {
  const queues = new Map<string, Queue>();
  let closing: Promise<void> | undefined;

  return {
    getQueue(name: string): Queue {
      if (closing) throw new Error("Job queue client is closing");
      const existing = queues.get(name);
      if (existing) return existing;
      const queue = createQueue(name);
      queues.set(name, queue);
      return queue;
    },

    getQueueNames(): string[] {
      return [...queues.keys()];
    },

    closeQueues(): Promise<void> {
      if (closing) return closing;
      const ownedQueues = [...queues.values()];
      queues.clear();
      closing = Promise.allSettled(
        ownedQueues.map((queue) => Promise.resolve().then(() => queue.close())),
      ).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Failed to close job queues");
        }
      });
      return closing;
    },
  };
}
