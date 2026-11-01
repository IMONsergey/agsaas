import { describe, expect, test } from "bun:test";
import { validateVaultKey } from "@midday/supabase/storage-path";
import { inboxAttachmentStorageKey } from "./inbox-storage-key";

const input = {
  teamId: "00000000-0000-4000-8000-000000000001",
  accountId: "00000000-0000-4000-8000-000000000002",
  referenceId: "provider-attachment-1",
  filename: "invoice.pdf",
  mimeType: "application/pdf",
};
describe("inbox provider attachment object identity", () => {
  test("equal filenames cannot overwrite a different attachment or account", () => {
    const first = inboxAttachmentStorageKey(input);
    expect(inboxAttachmentStorageKey(input)).toBe(first);
    expect(
      inboxAttachmentStorageKey({
        ...input,
        referenceId: "provider-attachment-2",
      }),
    ).not.toBe(first);
    expect(
      inboxAttachmentStorageKey({
        ...input,
        accountId: "00000000-0000-4000-8000-000000000003",
      }),
    ).not.toBe(first);
  });
  test("raw, encoded and normalized filenames cannot escape the own account namespace", () => {
    for (const filename of [
      "../../other-team/file.pdf",
      "..%2f..%2ffile.pdf",
      "%252e%252e%252fprivate",
      "..\\..\\private.pdf",
      "file?token=x#fragment",
      "\u0000file.pdf",
      "／．．／．．／file.pdf",
      "..",
      "",
    ]) {
      const key = inboxAttachmentStorageKey({ ...input, filename });
      const validated = validateVaultKey(key);
      expect(validated.pathTeamId).toBe(input.teamId);
      expect(validated.pathArray.slice(0, 3)).toEqual([
        input.teamId,
        "inbox",
        input.accountId,
      ]);
      expect(validated.pathArray).toHaveLength(5);
      expect(
        new URL(`https://storage.example.test/object/vault/${key}`).pathname,
      ).toStartWith(`/object/vault/${input.teamId}/inbox/${input.accountId}/`);
    }
  });
  test("invalid scope or missing provider identity fails before storage", () => {
    for (const patch of [
      { teamId: "../other" },
      { accountId: "foreign/path" },
      { referenceId: "" },
    ])
      expect(() => inboxAttachmentStorageKey({ ...input, ...patch })).toThrow();
  });
});
