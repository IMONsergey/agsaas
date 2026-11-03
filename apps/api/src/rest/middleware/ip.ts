import type { MiddlewareHandler } from "hono";
import type { Context } from "../types";
import { getClientIp } from "../utils/ip";

/**
 * Adds the socket-derived client IP to context. Only explicitly configured
 * trusted proxies may supply X-Forwarded-For; an empty value means unknown.
 */
export const withClientIp: MiddlewareHandler<Context> = async (c, next) => {
  const clientIp = getClientIp(c);
  c.set("clientIp", clientIp);

  await next();
};
