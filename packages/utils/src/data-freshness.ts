export type SourceFreshness =
  | "not_connected"
  | "manual"
  | "awaiting"
  | "current"
  | "stale"
  | "failed";
export type SourceState = {
  connectionCount: number;
  failedCount: number;
  checkedCount: number;
  oldestCheckedAt: string | null;
  recordCount: number;
};
export function sourceFreshness(
  source: SourceState,
  now = Date.now(),
): SourceFreshness {
  if (source.connectionCount === 0)
    return source.recordCount > 0 ? "manual" : "not_connected";
  if (source.failedCount > 0) return "failed";
  if (source.checkedCount < source.connectionCount || !source.oldestCheckedAt)
    return "awaiting";
  const checked = Date.parse(source.oldestCheckedAt);
  if (!Number.isFinite(checked) || checked > now + 300000) return "awaiting";
  return now - checked > 24 * 60 * 60 * 1000 ? "stale" : "current";
}
