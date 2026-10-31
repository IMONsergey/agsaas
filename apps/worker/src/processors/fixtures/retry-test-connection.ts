import type { ConnectionOptions } from "bullmq";

/** Test-only opt-in. Never accept production URLs, defaults, credentials or DB 0. */
export function readRetryTestConnection(
  configured?: string,
): ConnectionOptions | undefined {
  if (configured === undefined) return undefined;
  const message =
    "REDIS_TEST_URL must explicitly select loopback redis:// DB 15 without credentials, query or fragment";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(message);
  }
  const port = url.port ? Number(url.port) : 6379;
  if (
    url.protocol !== "redis:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/15" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    configured.includes("?") ||
    configured.includes("#") ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(message);
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    db: 15,
    connectTimeout: 3000,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  };
}
