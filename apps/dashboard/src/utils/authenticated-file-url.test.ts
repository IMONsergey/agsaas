import { describe, expect, test } from "bun:test";
import { authenticatedFileUrl } from "./authenticated-file-url";

const API = "https://api.example.test";
const KEY = "fixture-no-secret";

describe("file capabilities stay on their own origin", () => {
  test("supports own absolute and relative file URLs", () => {
    for (const source of [
      "/files/proxy?filePath=team%2Freceipt.png",
      `${API}/files/download/invoice?id=fixture`,
    ]) {
      const result = new URL(authenticatedFileUrl(source, API, KEY)!);
      expect(result.origin).toBe(API);
      expect(result.searchParams.get("fk")).toBe(KEY);
    }
  });
  for (const source of [
    "https://external.example/files/proxy",
    "//external.example/files/proxy",
    "https://api.example.test.external.example/files/proxy",
    "https://user:pass@api.example.test/files/proxy",
    "javascript:alert(1)",
    `${API}/redirect?next=/files/proxy`,
    `${API}/files/proxy/../../redirect`,
  ]) {
    test(`does not attach a capability to ${source}`, () => {
      expect(authenticatedFileUrl(source, API, KEY)).toBeNull();
    });
  }
});
