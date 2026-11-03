const quotaResources = new Set([
  "users",
  "bankConnections",
  "connectors",
  "storage",
  "inbox",
  "invoices",
]);
export function readTeamQuotaError(value: unknown): {
  message: string;
  resource?: string;
  used?: number;
  limit?: number;
  resetsAt?: string;
} | null {
  let current = value;
  for (
    let depth = 0;
    depth < 6 && current && typeof current === "object";
    depth++
  ) {
    const error = current as {
      message?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    if (error.message === "AGSAAS_QUOTA_METADATA_REQUIRED")
      return {
        message:
          "Storage usage needs reconciliation before another upload. Existing files remain available.",
      };
    if (error.message === "AGSAAS_ENTITLEMENT_WRITE_FORBIDDEN")
      return {
        message:
          "Subscription entitlements can only be changed by verified billing operations.",
      };
    if (
      error.message === "AGSAAS_QUOTA_EXCEEDED" ||
      error.message === "AGSAAS_PLAN_PAST_DUE"
    ) {
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(
          typeof error.detail === "string" ? error.detail : "{}",
        );
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          data = parsed as Record<string, unknown>;
      } catch {}
      const resource =
        typeof data.resource === "string" && quotaResources.has(data.resource)
          ? data.resource
          : undefined;
      const used =
        typeof data.used === "number" && Number.isFinite(data.used)
          ? data.used
          : undefined;
      const limit =
        typeof data.limit === "number" && Number.isFinite(data.limit)
          ? data.limit
          : undefined;
      const resetsAt =
        typeof data.resetsAt === "string" &&
        Number.isFinite(Date.parse(data.resetsAt))
          ? data.resetsAt
          : undefined;
      return {
        message:
          error.message === "AGSAAS_PLAN_PAST_DUE"
            ? "Subscription payment is overdue. New allocations are paused; reading and exporting existing data remains available."
            : `The ${resource ?? "workspace"} allowance has been reached. Existing data remains available.`,
        resource,
        used,
        limit,
        resetsAt,
      };
    }
    current = error.cause;
  }
  return null;
}
