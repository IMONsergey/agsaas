import { cors } from "hono/cors";

/** Credentialed CORS is limited to the two browser handshake endpoints. */
export function inboxOAuthStartCors() {
  const origins = (process.env.ALLOWED_API_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => {
      try {
        const url = new URL(origin);
        return (
          ["https:", "http:"].includes(url.protocol) && url.origin === origin
        );
      } catch {
        return false;
      }
    });
  return cors({
    origin: origins,
    credentials: true,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
}
