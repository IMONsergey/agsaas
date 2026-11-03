export function composioTeamEntityId(teamId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      teamId,
    )
  )
    throw new Error("Invalid connector workspace");
  return `agsaas-team-${teamId.toLowerCase()}`;
}
export function connectorCallbackUrl(requested?: string) {
  const origin = new URL(
    process.env.DASHBOARD_URL || process.env.MIDDAY_DASHBOARD_URL || "",
  );
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Connector callback is not configured");
  const callback = new URL("/connectors/callback", origin).href;
  if (requested && requested !== callback)
    throw new Error(
      "Connector callback must use this installation's dashboard",
    );
  return callback;
}
