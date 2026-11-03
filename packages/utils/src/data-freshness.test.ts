import { expect, test } from "bun:test";
import { sourceFreshness } from "./data-freshness";

const now = Date.parse("2026-11-03T12:00:00Z");
const base = {
  connectionCount: 0,
  failedCount: 0,
  checkedCount: 0,
  oldestCheckedAt: null,
  recordCount: 0,
};
test("no source, imported data, and successful zero are distinct", () => {
  expect(sourceFreshness(base, now)).toBe("not_connected");
  expect(sourceFreshness({ ...base, recordCount: 1 }, now)).toBe("manual");
  expect(
    sourceFreshness(
      {
        ...base,
        connectionCount: 1,
        checkedCount: 1,
        oldestCheckedAt: "2026-11-03T11:00:00Z",
      },
      now,
    ),
  ).toBe("current");
});
test("incomplete, delayed, future and failed providers do not claim current data", () => {
  expect(
    sourceFreshness(
      {
        ...base,
        connectionCount: 2,
        checkedCount: 1,
        oldestCheckedAt: "2026-11-03T11:00:00Z",
      },
      now,
    ),
  ).toBe("awaiting");
  expect(
    sourceFreshness(
      {
        ...base,
        connectionCount: 1,
        checkedCount: 1,
        oldestCheckedAt: "2026-11-01T11:00:00Z",
      },
      now,
    ),
  ).toBe("stale");
  expect(
    sourceFreshness(
      {
        ...base,
        connectionCount: 1,
        checkedCount: 1,
        oldestCheckedAt: "2027-01-01T00:00:00Z",
      },
      now,
    ),
  ).toBe("awaiting");
  expect(
    sourceFreshness({ ...base, connectionCount: 1, failedCount: 1 }, now),
  ).toBe("failed");
});
