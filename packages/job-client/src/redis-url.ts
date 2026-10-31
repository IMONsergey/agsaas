export class RedisQueueUrlError extends Error {
  constructor(reason: string) {
    // Never include the connection URL: it may contain credentials.
    super(`Invalid REDIS_QUEUE_URL: ${reason}`);
    this.name = "RedisQueueUrlError";
  }
}

/** Parse connection identity without changing the caller's retry/TLS policy. */
export function parseRedisQueueUrl(value: string | undefined) {
  if (!value) {
    throw new RedisQueueUrlError("an explicit connection URL is required");
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  ) {
    throw new RedisQueueUrlError(
      "whitespace and control characters are not permitted",
    );
  }
  if (value.includes("?") || value.includes("#")) {
    throw new RedisQueueUrlError(
      "query parameters and fragments are not supported",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RedisQueueUrlError("a valid Redis URL is required");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new RedisQueueUrlError(
      "only redis and rediss protocols are supported",
    );
  }
  if (!url.hostname) {
    throw new RedisQueueUrlError("a host is required");
  }

  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RedisQueueUrlError("the port must be between 1 and 65535");
  }

  let db: number | undefined;
  if (url.pathname && url.pathname !== "/") {
    if (!/^\/\d+$/.test(url.pathname)) {
      throw new RedisQueueUrlError(
        "the database must be a non-negative integer",
      );
    }
    db = Number(url.pathname.slice(1));
    if (!Number.isSafeInteger(db)) {
      throw new RedisQueueUrlError("the database must be a safe integer");
    }
  }

  let username: string | undefined;
  let password: string | undefined;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw new RedisQueueUrlError(
      "credentials contain invalid percent encoding",
    );
  }

  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    username,
    password,
    ...(db !== undefined && { db }),
    ...(url.protocol === "rediss:" && { tls: {} }),
  };
}
