import { expect, test } from "bun:test";
import { createReceiptObjectPath, createReceiptReferenceId } from "./receipt-path";
const team = "00000000-0000-4000-8000-000000000001";
test("identical display filenames never share an object version", () => {
  const paths = Array.from({ length: 100 }, () => createReceiptObjectPath(team, ".pdf").join("/"));
  expect(new Set(paths).size).toBe(100);
  expect(paths.every((path) => path.startsWith(`${team}/inbox/uploads/`) && path.endsWith(".pdf"))).toBe(true);
  expect(() => createReceiptObjectPath("untrusted", ".pdf")).toThrow();
  expect(createReceiptObjectPath(team, "../../bad").at(-1)?.endsWith(".bin")).toBe(true);
});
test("retry references are stable and isolated between tenants, users and platforms", async () => {
  const scope = { teamId: team, platform: "dashboard", userId: "user-1", referenceId: "message-1" };
  const key = await createReceiptReferenceId(scope);
  expect(await createReceiptReferenceId(scope)).toBe(key);
  expect(await createReceiptReferenceId({ ...scope, teamId: "other-team" })).not.toBe(key);
  expect(await createReceiptReferenceId({ ...scope, userId: "user-2" })).not.toBe(key);
  expect(await createReceiptReferenceId({ ...scope, platform: "slack" })).not.toBe(key);
  expect(await createReceiptReferenceId({ ...scope, referenceId: undefined })).toBeUndefined();
});
