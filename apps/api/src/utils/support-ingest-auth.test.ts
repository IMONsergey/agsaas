import { expect, test } from "bun:test";
import { isSupportIngestAuthorized } from "./support-ingest-auth";

test("support ingress rejects absent, weak, malformed and wrong service credentials", () => {
  const key = "a".repeat(48);
  expect(isSupportIngestAuthorized(undefined, key)).toBe(false);
  expect(isSupportIngestAuthorized("Bearer tiny", "tiny")).toBe(false);
  expect(isSupportIngestAuthorized("Bearer " + "b".repeat(48), key)).toBe(
    false,
  );
  expect(isSupportIngestAuthorized("a".repeat(1000), key)).toBe(false);
  expect(isSupportIngestAuthorized("Basic " + key, key)).toBe(false);
  expect(isSupportIngestAuthorized("Bearer " + key, key)).toBe(true);
});
