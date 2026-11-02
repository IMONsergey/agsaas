import { TZDate } from "@date-fns/tz";
import {
  addDays,
  addMonths,
  formatISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export function trackerPeriod({
  date,
  view,
  weekStartsOnMonday = false,
  timezone = "UTC",
}: {
  date: string;
  view: "week" | "month";
  weekStartsOnMonday?: boolean;
  timezone?: string;
}) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const current = parts
    ? new TZDate(
        Number(parts[1]),
        Number(parts[2]) - 1,
        Number(parts[3]),
        timezone,
      )
    : new TZDate(date, timezone);
  if (
    !Number.isFinite(+current) ||
    (parts && formatISO(current, { representation: "date" }) !== date)
  ) {
    throw new Error("Invalid tracker calendar date");
  }
  const start =
    view === "month"
      ? startOfMonth(current)
      : startOfWeek(current, { weekStartsOn: weekStartsOnMonday ? 1 : 0 });
  const end = view === "month" ? addMonths(start, 1) : addDays(start, 7);
  return {
    start: new Date(+start),
    end: new Date(+end),
    from: formatISO(start, { representation: "date" }),
    to: formatISO(addDays(end, -1), { representation: "date" }),
  };
}

export function clippedTrackerDuration(
  entry: {
    date: string | null;
    start: string | null;
    stop: string | null;
    duration: number | null;
  },
  period: ReturnType<typeof trackerPeriod>,
) {
  const duration = entry.duration ?? 0;
  if (duration <= 0) return 0;
  const start = entry.start ? Date.parse(entry.start) : Number.NaN;
  const stop = entry.stop ? Date.parse(entry.stop) : Number.NaN;
  if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) {
    const overlap = Math.max(
      0,
      Math.min(stop, +period.end) - Math.max(start, +period.start),
    );
    // Keep recorded adjustments, apportioned to the actual overlapping interval.
    return Math.round((duration * overlap) / (stop - start));
  }
  // Historical duration-only entries have no interval to split.
  return entry.date && entry.date >= period.from && entry.date <= period.to
    ? duration
    : 0;
}
