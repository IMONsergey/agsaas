import { spawnSync } from "node:child_process";

type Severity = "low" | "moderate" | "high" | "critical";
type Advisory = { url: string; severity: Severity };
const severities = new Set(["low", "moderate", "high", "critical"]);

// Query the registry against the exact lockfile. Missing or malformed results
// must not turn a registry outage into a successful security check.
const result = spawnSync("bun", ["audit", "--json"], {
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error || (result.status !== 0 && result.status !== 1)) {
  throw new Error(
    "Dependency audit could not complete. Retry after checking registry availability.",
  );
}
let report: unknown;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error("Dependency audit did not return a valid report.");
}
if (!report || typeof report !== "object" || Array.isArray(report)) {
  throw new Error("Unsupported dependency audit report.");
}
const counts: Record<Severity, Set<string>> = {
  low: new Set(),
  moderate: new Set(),
  high: new Set(),
  critical: new Set(),
};
const blocking: Array<{
  package: string;
  advisory: string;
  severity: Severity;
}> = [];
for (const [name, value] of Object.entries(report)) {
  if (!Array.isArray(value))
    throw new Error("Unsupported dependency advisory list.");
  for (const item of value) {
    if (
      !item ||
      typeof item.url !== "string" ||
      !severities.has(item.severity)
    ) {
      throw new Error("Unsupported dependency advisory record.");
    }
    const advisory = item as Advisory;
    counts[advisory.severity].add(advisory.url);
    if (advisory.severity === "high" || advisory.severity === "critical") {
      blocking.push({
        package: name,
        advisory: advisory.url,
        severity: advisory.severity,
      });
    }
  }
}
console.log(
  JSON.stringify(
    {
      advisories: Object.fromEntries(
        Object.entries(counts).map(([level, entries]) => [level, entries.size]),
      ),
      blocking,
    },
    null,
    2,
  ),
);
if (blocking.length) process.exitCode = 1;
