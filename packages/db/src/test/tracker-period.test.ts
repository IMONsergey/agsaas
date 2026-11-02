import { describe, expect, test } from "bun:test";
import { clippedTrackerDuration, trackerPeriod } from "../utils/tracker-period";

const entry = (
  date: string,
  start: string,
  stop: string,
  duration: number,
) => ({ date, start, stop, duration });
describe("tracker reporting intervals", () => {
  test("forecast ISO timestamp callers retain the existing input contract", () => {
    const period = trackerPeriod({
      date: "2026-11-15T14:25:00.000Z",
      view: "month",
    });
    expect([period.from, period.to]).toEqual(["2026-11-01", "2026-11-30"]);
    expect(() =>
      trackerPeriod({ date: "2026-02-31", view: "month" }),
    ).toThrow();
  });
  test("neighboring whole days do not enter a month", () => {
    const period = trackerPeriod({ date: "2026-11-15", view: "month" });
    const rows = [
      entry("2026-10-31", "2026-10-31T10:00:00Z", "2026-10-31T11:00:00Z", 3600),
      entry("2026-11-01", "2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", 7200),
      entry(
        "2026-11-30",
        "2026-11-30T10:00:00Z",
        "2026-11-30T13:00:00Z",
        10800,
      ),
      entry(
        "2026-12-01",
        "2026-12-01T10:00:00Z",
        "2026-12-01T14:00:00Z",
        14400,
      ),
    ];
    expect(
      rows.reduce((sum, row) => sum + clippedTrackerDuration(row, period), 0),
    ).toBe(5 * 3600);
  });
  test("a midnight entry is apportioned without counting the whole buffered day", () => {
    const row = entry(
      "2026-10-31",
      "2026-10-31T23:00:00Z",
      "2026-11-01T01:00:00Z",
      7200,
    );
    expect(
      clippedTrackerDuration(
        row,
        trackerPeriod({ date: "2026-11-15", view: "month" }),
      ),
    ).toBe(3600);
    expect(
      clippedTrackerDuration(
        row,
        trackerPeriod({ date: "2026-10-15", view: "month" }),
      ),
    ).toBe(3600);
  });
  test("a user timezone, including DST, defines calendar boundaries", () => {
    const period = trackerPeriod({
      date: "2026-11-15",
      view: "month",
      timezone: "America/New_York",
    });
    expect(period.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    const row = entry(
      "2026-11-01",
      "2026-11-01T03:00:00Z",
      "2026-11-01T05:00:00Z",
      7200,
    );
    expect(clippedTrackerDuration(row, period)).toBe(3600);
  });
  test("week boundaries respect Monday preference and legacy duration-only dates", () => {
    const period = trackerPeriod({
      date: "2026-11-01",
      view: "week",
      weekStartsOnMonday: true,
    });
    expect([period.from, period.to]).toEqual(["2026-10-26", "2026-11-01"]);
    expect(
      clippedTrackerDuration(
        { date: "2026-11-01", start: null, stop: null, duration: 60 },
        period,
      ),
    ).toBe(60);
    expect(
      clippedTrackerDuration(
        { date: "2026-11-02", start: null, stop: null, duration: 60 },
        period,
      ),
    ).toBe(0);
  });
});
