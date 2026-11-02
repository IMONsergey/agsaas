import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Event = {
  event: string;
  resource?: string;
  type?: string;
  exitCode?: number;
  timedOut?: boolean;
};
const fixturePath = fileURLToPath(
  new URL("./fixtures/lifecycle-child.ts", import.meta.url),
);

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Worker test child deadline exceeded")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function runChild(
  scenario: string,
  drive?: (
    child: ChildProcess,
    waitFor: (event: (value: Event) => boolean) => Promise<Event>,
  ) => Promise<void>,
) {
  const child = spawn(process.execPath, [fixturePath, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
    // No production/provider credentials are inherited by the test process.
    env: { NODE_ENV: "test" },
  });
  const events: Event[] = [];
  const listeners = new Set<(event: Event) => void>();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    const event = JSON.parse(line) as Event;
    events.push(event);
    for (const listener of listeners) listener(event);
  });
  // Drain stderr as well; child failures are reported via exit status.
  child.stderr!.resume();
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const waitFor = async (
    matches: (event: Event) => boolean,
  ): Promise<Event> => {
    const existing = events.find(matches);
    if (existing) return existing;
    let listener: ((event: Event) => void) | undefined;
    try {
      return await withDeadline(
        Promise.race([
          new Promise<Event>((resolve) => {
            listener = (event) => {
              if (matches(event)) resolve(event);
            };
            listeners.add(listener);
          }),
          closed.then(() => {
            throw new Error(
              "Worker test child exited before the expected event",
            );
          }),
        ]),
      );
    } finally {
      if (listener) listeners.delete(listener);
    }
  };

  try {
    await waitFor((event) => event.event === "ready");
    await drive?.(child, waitFor);
    return { ...(await withDeadline(closed)), events };
  } finally {
    // Only terminate this exact child created by the test, never a worker in the environment.
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await withDeadline(closed);
    lines.close();
  }
}

describe("worker process signals in isolated children", () => {
  test("SIGTERM followed by SIGINT drains every resource once and exits zero", async () => {
    const result = await runChild("signals", async (child, waitFor) => {
      expect(child.kill("SIGTERM")).toBe(true);
      await waitFor(
        (event) => event.event === "close" && event.resource === "worker",
      );
      expect(child.kill("SIGINT")).toBe(true);
    });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(
      result.events
        .filter((event) => event.event === "close")
        .map((event) => event.resource)
        .sort(),
    ).toEqual([
      "cache",
      "database",
      "http",
      "queues",
      "sentry",
      "timer",
      "worker",
    ]);
    expect(
      result.events.filter((event) => event.event === "result"),
    ).toHaveLength(1);
  });

  test("a cleanup error still closes other resources and exits nonzero", async () => {
    const result = await runChild("cleanup-error", async (child) => {
      child.kill("SIGTERM");
    });
    expect(result.code).toBe(1);
    expect(result.events).toContainEqual({
      event: "close",
      resource: "database",
    });
    expect(result.events).toContainEqual({
      event: "close",
      resource: "sentry",
    });
    expect(result.events).toContainEqual({
      event: "error",
      resource: "queues",
    });
  });

  test("a never-ending drain reaches the deadline and exits nonzero", async () => {
    const result = await runChild("timeout", async (child) => {
      child.kill("SIGTERM");
    });
    expect(result.code).toBe(1);
    expect(
      result.events.find((event) => event.event === "result"),
    ).toMatchObject({ timedOut: true, exitCode: 1 });
  });

  test.each([
    ["exception", "uncaughtException"],
    ["rejection", "unhandledRejection"],
  ])("fatal %s drains and exits nonzero", async (scenario, type) => {
    const result = await runChild(scenario!);
    expect(result.code).toBe(1);
    expect(result.events).toContainEqual({ event: "fatal", type });
    expect(result.events).toContainEqual({
      event: "close",
      resource: "database",
    });
    expect(result.events).toContainEqual({
      event: "close",
      resource: "sentry",
    });
  });
});
