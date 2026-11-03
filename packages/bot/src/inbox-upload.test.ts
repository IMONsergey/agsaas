import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "@midday/db/client";
import { withTeamStorage } from "../../supabase/src/utils/team-storage";
const teamId = "00000000-0000-4000-8000-000000000001";
const objects = new Map<string, Uint8Array>();
const rows: Array<any> = [];
const analyzed: string[] = [];
const savedFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => { throw new Error("Live network forbidden in receipt tests"); }, { preconnect() {} });
afterAll(() => { globalThis.fetch = savedFetch; });
mock.module("@midday/supabase/job", () => ({ createTeamClient: (team: string) => withTeamStorage({ storage: { from: (_bucket: string) => ({
  upload: async (key: string, data: Uint8Array, options: { upsert: boolean }) => {
    expect(options.upsert).toBe(false);
    if (objects.has(key)) return { data: null, error: new Error("Object exists") };
    objects.set(key, Uint8Array.from(data)); return { data: { path: key }, error: null };
  },
  remove: async (keys: string[]) => { for (const key of keys) objects.delete(key); return { data: [], error: null }; },
  createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://storage.example.test/${key}` }, error: null }),
}) } }, team) }));
mock.module("@midday/db/queries", () => ({
  createInbox: async (_db: unknown, params: any) => { const old = params.referenceId && rows.find((row) => row.referenceId === params.referenceId); if (old) return old; const row = { ...params, id: `fixture-${rows.length + 1}` }; rows.push(row); return row; },
  updateInboxWithProcessedData: async (_db: unknown, params: any) => params,
  updateInbox: async () => {}, groupRelatedInboxItems: async () => {},
}));
mock.module("@midday/documents", () => ({ DocumentClient: class { async getInvoiceOrReceipt({ documentUrl }: { documentUrl: string }) { analyzed.push(documentUrl); return { document_type: "other", name: "Receipt" }; } } }));
mock.module("@midday/job-client", () => ({ triggerJob: async () => { throw new Error("Unexpected queue call for other document"); } }));
const { processInboxUpload } = await import("./inbox-upload");
const upload = (data: number[], referenceId?: string) => processInboxUpload({ db: {} as Database, teamId, userId: "user-1", fileData: new Uint8Array(data), mimeType: "application/pdf", fileName: "../../Receipt.pdf", referenceId, platform: "dashboard" });
beforeEach(() => { objects.clear(); rows.length = 0; analyzed.length = 0; });
describe("receipt bytes are immutable and reference-scoped", () => {
  test("two same-name uploads preserve both objects and the display filename", async () => {
    await upload([1, 2]); await upload([3, 4]);
    expect(objects.size).toBe(2); expect(rows).toHaveLength(2);
    expect(rows[0].filePath).not.toEqual(rows[1].filePath);
    expect(rows[0].fileName).toBe("../../Receipt.pdf");
    expect([...objects.values()].map((bytes) => [...bytes])).toEqual([[1, 2], [3, 4]]);
    for (const key of objects.keys()) { expect(key.startsWith(`${teamId}/inbox/uploads/`)).toBe(true); expect(key).not.toContain(".."); }
  });
  test("retry with changed bytes cannot overwrite or relabel the persisted original", async () => {
    await upload([1, 2], "same-message"); await upload([9, 9], "same-message");
    expect(objects.size).toBe(1); expect(rows).toHaveLength(1);
    expect([...objects.values()][0]).toEqual(new Uint8Array([1, 2]));
    expect(analyzed).toHaveLength(2); expect(analyzed[1]).toBe(analyzed[0]);
  });
});
