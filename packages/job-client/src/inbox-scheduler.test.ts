import { describe, expect, test } from "bun:test";
import { inboxSyncSchedulerId } from "./inbox-scheduler";

describe("own inbox scheduler identity", () => {
  test("derives the persisted BullMQ ID from the account UUID only", () => {
    expect(inboxSyncSchedulerId("ABCDEF01-2345-4678-9123-ABCDEF012345")).toBe(
      "scheduler:inbox-sync-abcdef01-2345-4678-9123-abcdef012345",
    );
  });
  test("rejects legacy cloud IDs and untrusted scheduler/path selectors", () => {
    for (const value of [
      "",
      "sched_cloud_123",
      "scheduler:other-account",
      "../../other",
      "00000000-0000-4000-8000-000000000001/other",
    ])
      expect(() => inboxSyncSchedulerId(value)).toThrow(
        "Invalid inbox account identity",
      );
  });
});
