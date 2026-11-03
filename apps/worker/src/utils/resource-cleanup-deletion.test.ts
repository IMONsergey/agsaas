import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CleanupTarget } from "@midday/db/cleanup";
import type { DatabaseOrTransaction } from "@midday/db/client";
import type { ResourceCleanup } from "@midday/db/queries/resource-cleanups";

const teamId = "873902e8-e1ba-4350-abff-84cae07e790f";
const target: CleanupTarget = {
  version: 1,
  kind: "storage-object",
  teamId,
  actorUserId: null,
  targetId: "a".repeat(64),
  provider: null,
  data: { path: teamId + "/inbox/original.pdf" },
};
const row: ResourceCleanup = {
  id: "0eeae853-cfae-4217-9a61-9a90a31ee04d",
  kind: "storage-object",
  teamId,
  actorUserId: null,
  targetId: target.targetId,
  provider: null,
  status: "processing",
  encryptedPayload: "fixture",
  attempts: 1,
  reason: null,
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
  dispatchToken: "ee8c7c32-d89b-4c79-b7a0-71a0193c3df2",
};
const events: string[] = [];
let plan = { pending: 1, maximumBytes: 7 };
let readFails = false;
let saveFails = false;
let planFails = false;
const retained: unknown[] = [];
mock.module("@midday/db/queries/resource-cleanups", () => ({
  openResourceCleanup: () => target,
  finishResourceCleanup: async () => true,
}));
mock.module("@midday/db/queries/inbox-deletion-receipts", () => ({
  getInboxDeletionDigestPlan: async () => {
    events.push("plan");
    if (planFails) throw new Error("DB proof read unavailable");
    return plan;
  },
  retainInboxDeletionDigest: async (
    _db: unknown,
    claim: ResourceCleanup,
    evidence: unknown,
  ) => {
    expect(claim.id).toBe(row.id);
    expect(claim.dispatchToken).toBe(row.dispatchToken);
    events.push("retain");
    retained.push(evidence);
    if (saveFails) throw new Error("proof write unavailable");
    return true;
  },
}));
mock.module("@midday/supabase/deletion-proof", () => ({
  readStorageDeletionDigest: async (
    scope: { teamId: string },
    path: string,
    maximumBytes: number,
  ) => {
    expect(scope.teamId).toBe(teamId);
    expect(path).toBe(target.data.path);
    expect(maximumBytes).toBe(plan.maximumBytes);
    events.push("digest");
    if (readFails) throw new Error("original bytes are unavailable");
    return { sha256: "b".repeat(64), size: 7 };
  },
}));
mock.module("@midday/supabase/cleanup", () => ({
  createStorageCleanupClient: () => ({
    remove: async (bucket: string, paths: string[]) => {
      expect(bucket).toBe("vault");
      expect(paths).toEqual([target.data.path!]);
      events.push("erase");
    },
  }),
}));
mock.module("@midday/supabase/job", () => ({
  createClient: () => {
    throw new Error("Unexpected Auth capability");
  },
}));
const { executeResourceCleanup } = await import("./resource-cleanup");
const db = {
  execute: async () => {
    events.push("verify-absent");
    return { rows: [{ exists: false }] };
  },
} as unknown as DatabaseOrTransaction;
beforeEach(() => {
  plan = { pending: 1, maximumBytes: 7 };
  readFails = false;
  saveFails = false;
  planFails = false;
  events.length = 0;
  retained.length = 0;
});
describe("legacy deletion proof does not block erasure", () => {
  test("retains a bounded original digest before deleting its exact retained object", async () => {
    expect(await executeResourceCleanup(db, row)).toEqual({
      status: "completed",
    });
    expect(events).toEqual([
      "plan",
      "digest",
      "retain",
      "erase",
      "verify-absent",
    ]);
    expect(retained).toEqual([{ sha256: "b".repeat(64), size: 7 }]);
  });
  test("a read failure records explicit uncertainty and still erases bytes", async () => {
    readFails = true;
    expect(await executeResourceCleanup(db, row)).toEqual({
      status: "completed",
    });
    expect(retained).toEqual([{ failure: "download_unavailable" }]);
    expect(events).toContain("erase");
  });
  test("an unverifiable original bound skips downloading and still erases bytes", async () => {
    plan.maximumBytes = 0;
    await executeResourceCleanup(db, row);
    expect(retained).toEqual([{ failure: "size_unverifiable" }]);
    expect(events).not.toContain("digest");
    expect(events).toContain("erase");
  });
  test("unavailable proof read/save never turns erasure into permanent retry", async () => {
    for (const boundary of ["plan", "save"] as const) {
      events.length = 0;
      planFails = boundary === "plan";
      saveFails = boundary === "save";
      expect((await executeResourceCleanup(db, row)).status).toBe("completed");
      expect(events).toContain("erase");
    }
  });
  test("known evidence never causes a second download", async () => {
    plan.pending = 0;
    await executeResourceCleanup(db, row);
    expect(events).toEqual(["plan", "erase", "verify-absent"]);
  });
});
