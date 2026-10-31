import { describe, expect, test } from "bun:test";
import {
  assertTeamStoragePath,
  parseTeamStoragePath,
  StoragePathError,
} from "./storage";

const teamA = "11111111-1111-4111-8111-111111111111";
const teamB = "22222222-2222-4222-8222-222222222222";

describe("team storage object keys", () => {
  for (const name of [
    "invoice.pdf",
    "exports/export-2026-10-31.zip",
    "Выписки/Счёт № 1.pdf",
    "receipts/100% paid + tax.csv",
    "receipts/literal%25value%20name.pdf",
    "receipts/literal%zzname.pdf",
    ".../.hidden-file",
  ]) {
    test(`preserves the exact object name: ${name}`, () => {
      const path = `${teamA}/${name}`;
      expect(assertTeamStoragePath(path, teamA)).toBe(path);
      expect(parseTeamStoragePath(path).segments.join("/")).toBe(path);
    });
  }

  test("accepts path tokens without mutating them", () => {
    const tokens = [teamA, "inbox", "Счёт 1.pdf"];
    expect(assertTeamStoragePath(tokens, teamA)).toBe(tokens.join("/"));
    expect(tokens).toEqual([teamA, "inbox", "Счёт 1.pdf"]);
  });

  const invalidPaths = [
    "",
    teamA,
    `${teamA}/`,
    `/${teamA}/file.pdf`,
    `vault/${teamA}/file.pdf`,
    `${teamA}//file.pdf`,
    `${teamA}/./file.pdf`,
    `${teamA}/../${teamB}/file.pdf`,
    `${teamA}/folder/..`,
    `${teamA}/%2e/file.pdf`,
    `${teamA}/.%2E/${teamB}/file.pdf`,
    `${teamA}/%2e%2E/${teamB}/file.pdf`,
    `${teamA}/%252E%252E/${teamB}/file.pdf`,
    `${teamA}/%2ffile.pdf`,
    `${teamA}/%252ffile.pdf`,
    `${teamA}/folder\\..\\file.pdf`,
    `${teamA}/%5c../file.pdf`,
    `${teamA}/file.pdf?download=1`,
    `${teamA}/file.pdf#fragment`,
    `${teamA}/file%3fquery.pdf`,
    `${teamA}/file%23fragment.pdf`,
    `${teamA}/file\n.pdf`,
    `${teamA}/file%00.pdf`,
    `${teamA}/file%7f.pdf`,
    `${teamA}/file%250a.pdf`,
  ];

  for (const [index, path] of invalidPaths.entries()) {
    test(`rejects ambiguous or incomplete key ${index + 1}`, () => {
      expect(() => parseTeamStoragePath(path)).toThrow(StoragePathError);
    });
  }

  test("rejects a foreign team without exposing the supplied key", () => {
    const path = `${teamB}/private-financial-report.pdf`;
    try {
      assertTeamStoragePath(path, teamA);
      throw new Error("Expected a rejected storage key");
    } catch (error) {
      expect(error).toBeInstanceOf(StoragePathError);
      expect((error as StoragePathError).code).toBe("TEAM_MISMATCH");
      expect((error as Error).message).not.toContain(teamB);
      expect((error as Error).message).not.toContain("private-financial-report");
    }
  });
});
