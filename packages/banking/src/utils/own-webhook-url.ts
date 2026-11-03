/** Callback destinations belong to this installation, independent of the
 * browser-selected provider environment. No upstream deployment is a fallback. */
export function getBankWebhookUrl(
  provider: "plaid",
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.API_URL?.trim() || env.MIDDAY_API_URL?.trim();
  if (!raw) throw new Error("Own banking callback origin is not configured");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid own banking callback origin");
  }
  const local =
    env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname === "midday.ai" ||
    url.hostname.endsWith(".midday.ai")
  )
    throw new Error("Invalid own banking callback origin");
  return `${url.origin}/webhook/${provider}`;
}
