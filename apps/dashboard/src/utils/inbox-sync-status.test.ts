import { describe, expect, test } from "bun:test";
import {
  inboxQueuedAttachmentCount,
  inboxSyncPhase,
} from "./inbox-sync-status";

describe("own inbox queue status", () => {
  test("waiting, delayed and active jobs stay pending until an own completion", () => {
    for (const state of [undefined, "waiting", "delayed", "active"])
      expect(inboxSyncPhase("inbox-provider:123", state)).toBe("SYNCING");
    expect(inboxSyncPhase("inbox-provider:123", "completed")).toBe("COMPLETED");
    expect(inboxSyncPhase(undefined, "completed")).toBeNull();
  });
  test("failed, missing and unauthorized jobs stop instead of spinning or showing success", () => {
    for (const state of ["failed", "unknown"])
      expect(inboxSyncPhase("inbox-provider:123", state)).toBe("FAILED");
    expect(inboxSyncPhase("inbox-provider:123", "completed", true)).toBe(
      "FAILED",
    );
  });
  test("only an actual count may be described as attachments queued", () => {
    expect(inboxQueuedAttachmentCount({ attachmentsProcessed: 3 })).toBe(3);
    expect(inboxQueuedAttachmentCount({ attachmentsProcessed: 0 })).toBe(0);
    for (const result of [
      null,
      {},
      [],
      { attachmentsProcessed: -1 },
      { attachmentsProcessed: 1.5 },
      { attachmentsProcessed: "3" },
      { attachmentsProcessed: Number.NaN },
      { attachmentsProcessed: Number.POSITIVE_INFINITY },
    ])
      expect(inboxQueuedAttachmentCount(result)).toBeUndefined();
  });
});
