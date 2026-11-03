import { describe, expect, test } from "bun:test";
import { parseQueuedJobReservation } from "./queued-admission-protocol";
import { inboxRetrySnapshot } from "./retry-inbox-job";

describe("queued admission generation contract", () => {
  test("keeps known legacy slots readable and rejects malformed or pending state", () => {
    expect(parseQueuedJobReservation(["reserved", "legacy", "none"])).toEqual({
      generation: "legacy",
      retry: "none",
    });
    expect(parseQueuedJobReservation(["missing", ""])).toBeNull();
    for (const value of [
      ["invalid"],
      ["reserved", "pending"],
      ["reserved", "not-a-token", "dispatched"],
      ["reserved", "legacy", "unknown"],
    ]) {
      expect(() => parseQueuedJobReservation(value)).toThrow();
    }
  });
  test("requires a retained failed-attempt snapshot and excludes parent flows", () => {
    const row = {
      finishedOn: 1,
      attemptsMade: 1,
      attemptsStarted: 1,
      data: { teamId: "fixture" },
      opts: {},
    };
    expect(inboxRetrySnapshot(row)).toEqual({
      finishedOn: 1,
      attemptsMade: 1,
      attemptsStarted: 1,
      dataJson: JSON.stringify(row.data),
      lifo: false,
    });
    expect(() =>
      inboxRetrySnapshot({ ...row, finishedOn: undefined }),
    ).toThrow();
    expect(() =>
      inboxRetrySnapshot({
        ...row,
        opts: { parent: { id: "parent", queue: "q" } },
      }),
    ).toThrow();
  });
});
