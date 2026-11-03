import { describe, expect, test } from "bun:test";
import { assertChatRequestBudget } from "../../chat/request-budget";

describe("chat decoded resource budgets", () => {
  test("accepts bounded text and real base64 attachments", () => {
    expect(
      assertChatRequestBudget([
        {
          parts: [
            { type: "text", text: "Process this receipt" },
            { type: "file", url: "data:application/pdf;base64,YWJjZA==" },
          ],
        },
      ]),
    ).toMatchObject({ fileCount: 1, decodedBytes: 4 });
  });
  test("counts UTF-8 bytes, not just characters, before any provider or storage IO", () => {
    expect(() =>
      assertChatRequestBudget([
        { parts: [{ type: "text", text: "я".repeat(50001) }] },
      ]),
    ).toThrow("context budget");
  });
  test("rejects malformed/remote URLs and excessive attachment counts", () => {
    for (const url of [
      "https://attacker.example/file",
      "data:application/pdf;base64,%%%%",
      "data:application/pdf;base64,YQ=",
    ])
      expect(() =>
        assertChatRequestBudget([{ parts: [{ type: "file", url }] }]),
      ).toThrow();
    expect(() =>
      assertChatRequestBudget([
        {
          parts: Array.from({ length: 6 }, () => ({
            type: "file",
            url: "data:application/pdf;base64,YQ==",
          })),
        },
      ]),
    ).toThrow("five files");
  });
  test("rejects per-file and combined decoded-byte excess without allocating decoded files", () => {
    const large =
      "data:application/pdf;base64," +
      "AAAA".repeat(Math.ceil((5 * 1024 * 1024 + 1) / 3));
    expect(() =>
      assertChatRequestBudget([{ parts: [{ type: "file", url: large }] }]),
    ).toThrow("5 MiB");
    const part = {
      type: "file",
      url: `data:application/pdf;base64,${"AAAA".repeat(1400000)}`,
    };
    expect(() =>
      assertChatRequestBudget([{ parts: [part, part, part] }]),
    ).toThrow("10 MiB");
  });
});
