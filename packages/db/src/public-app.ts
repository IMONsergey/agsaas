/** The only app-installation shape allowed across a browser/API boundary.
 * Credential-bearing config remains available through server-only app queries.
 * This is an allowlist: new providers and new nested fields are private by default.
 */
export type PublicApp = {
  app_id: string;
  settings: unknown;
  config: Record<string, unknown> | null;
};

type AppLike = { app_id?: string; appId?: string; settings?: unknown; config?: unknown };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function strings(value: unknown, keys: readonly string[]) {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
}
function publicConfig(appId: string, value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  const source = record(value);
  switch (appId) {
    case "slack": return strings(source, ["team_id", "team_name", "channel", "channel_id"]);
    case "xero": return strings(source, ["provider", "tenantId", "tenantName", "expiresAt"]);
    case "quickbooks": return strings(source, ["provider", "realmId", "companyName", "expiresAt"]);
    case "fortnox": return strings(source, ["provider", "companyId", "companyName", "expiresAt"]);
    case "telegram":
    case "whatsapp":
    case "sendblue": {
      const keys = appId === "telegram"
        ? ["userId", "username", "displayName", "connectedAt"]
        : ["phoneNumber", "displayName", "connectedAt"];
      return { connections: Array.isArray(source.connections) ? source.connections.map((item) => strings(item, keys)) : [] };
    }
    default: return null;
  }
}
function publicSettings(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const setting = record(entry);
    const result: Record<string, unknown> = strings(setting, ["id", "label", "description", "type"]);
    if (typeof setting.required === "boolean") result.required = setting.required;
    if (Object.hasOwn(setting, "value")) result.value = setting.value;
    return result;
  });
}
export function toPublicApp(app: AppLike): PublicApp;
export function toPublicApp(app: AppLike | null | undefined): PublicApp | null;
export function toPublicApp(app: AppLike | null | undefined): PublicApp | null {
  if (!app) return null;
  const appId = app.app_id ?? app.appId;
  if (!appId) throw new Error("Missing app identifier");
  return { app_id: appId, settings: publicSettings(app.settings), config: publicConfig(appId, app.config) };
}
