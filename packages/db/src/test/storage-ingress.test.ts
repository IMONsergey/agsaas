import { describe, expect, test } from "bun:test";
import type { Database } from "../client";
import { assertInboxUploadScope, createInbox } from "../queries/inbox";
import {
  assertTransactionAttachmentScope,
  createAttachments,
} from "../queries/transaction-attachments";

const TEAM = "00000000-0000-4000-8000-000000000001";
const FOREIGN = "00000000-0000-4000-8000-000000000002";

function denyDb() {
  let calls = 0;
  const db = new Proxy(
    {},
    {
      get() {
        calls++;
        throw new Error("Unexpected database IO");
      },
    },
  ) as Database;
  return { db, calls: () => calls };
}

describe("persisted attachment references cannot escape a team", () => {
  for (const filePath of [
    [FOREIGN, "receipt.pdf"],
    [TEAM, "..", "receipt.pdf"],
    [TEAM, "%2f", "receipt.pdf"],
    [`${TEAM}/inbox`, "receipt.pdf"],
  ]) {
    test(`rejects all ingress before DB work: ${JSON.stringify(filePath)}`, async () => {
      const { db, calls } = denyDb();
      await expect(
        createAttachments(db, {
          teamId: TEAM,
          attachments: [
            {
              path: filePath,
              type: "application/pdf",
              name: "receipt.pdf",
              size: 4,
            },
          ],
        }),
      ).rejects.toThrow("Invalid storage key");
      await expect(
        createInbox(db, {
          teamId: TEAM,
          filePath,
          displayName: "Receipt",
          fileName: "receipt.pdf",
          contentType: "application/pdf",
          size: 4,
        }),
      ).rejects.toThrow("Invalid storage key");
      await expect(
        assertTransactionAttachmentScope(db, TEAM, [{ filePath }]),
      ).rejects.toThrow("Invalid storage key");
      await expect(
        assertInboxUploadScope(db, TEAM, [{ filePath }]),
      ).rejects.toThrow("Invalid storage key");
      expect(calls()).toBe(0);
    });
  }
  test("a mixed batch is rejected before any transaction or partial write", async () => {
    const { db, calls } = denyDb();
    await expect(
      createAttachments(db, {
        teamId: TEAM,
        attachments: [
          {
            path: [TEAM, "ok.pdf"],
            type: "application/pdf",
            name: "ok.pdf",
            size: 4,
          },
          {
            path: [FOREIGN, "private.pdf"],
            type: "application/pdf",
            name: "private.pdf",
            size: 4,
          },
        ],
      }),
    ).rejects.toThrow("Invalid storage key");
    expect(calls()).toBe(0);
  });
  test("valid manual uploads pass preflight without a mailbox or transaction reference", async () => {
    const { db, calls } = denyDb();
    const upload = { filePath: [TEAM, "inbox", "Отчет.pdf"] };
    await assertInboxUploadScope(db, TEAM, [upload]);
    await assertTransactionAttachmentScope(db, TEAM, [upload]);
    expect(calls()).toBe(0);
  });
  test("missing/foreign referenced records fail before side effects", async () => {
    const query = {
      from: () => query,
      where: () => query,
      for: async () => [],
    };
    const db = { select: () => query } as unknown as Database;
    await expect(
      assertInboxUploadScope(db, TEAM, [
        { filePath: [TEAM, "receipt.pdf"], inboxAccountId: FOREIGN },
      ]),
    ).rejects.toThrow("Resource not found");
    await expect(
      assertTransactionAttachmentScope(db, TEAM, [
        { filePath: [TEAM, "receipt.pdf"], transactionId: FOREIGN },
      ]),
    ).rejects.toThrow("Resource not found");
  });
});
