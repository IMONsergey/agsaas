import { createHash } from "node:crypto";
import { publicMiddleware } from "@api/rest/middleware";
import type { Context } from "@api/rest/types";
import { websiteSupportSchema } from "@api/schemas/support";
import { isSupportIngestAuthorized } from "@api/utils/support-ingest-auth";
import { OpenAPIHono } from "@hono/zod-openapi";
import { SupportRequestError, submitSupportRequest } from "@midday/db/queries";
import { bodyLimit } from "hono/body-limit";

export const supportIngestRouter = new OpenAPIHono<Context>();
supportIngestRouter.use("*", async (c, next) => {
  if (
    !isSupportIngestAuthorized(
      c.req.header("authorization"),
      process.env.AGSAAS_SUPPORT_INGEST_KEY,
    )
  )
    return c.json({ error: "Support ingestion unavailable" }, 403);
  await next();
});
supportIngestRouter.use(
  "*",
  bodyLimit({
    maxSize: 49152,
    onError: (c) => c.json({ error: "Request too large" }, 413),
  }),
  ...publicMiddleware,
);
supportIngestRouter.post("/ingest", async (c) => {
  const parsed = websiteSupportSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "Invalid support request" }, 400);
  const input = parsed.data;
  try {
    const receipt = await submitSupportRequest(c.get("db"), {
      id: input.requestId,
      source: "website",
      scopeKey: `email:${createHash("sha256").update(input.email.toLowerCase()).digest("hex")}`,
      email: input.email,
      fullName: input.fullName,
      subject: input.subject,
      priority: input.priority,
      product: input.type,
      message: input.message,
    });
    return c.json(receipt, 201, { "Cache-Control": "no-store" });
  } catch (error) {
    if (error instanceof SupportRequestError)
      return c.json(
        {
          error:
            error.code === "CONFLICT"
              ? "Request reference already used"
              : "Too many requests",
        },
        error.code === "CONFLICT" ? 409 : 429,
      );
    return c.json(
      {
        error: "Receipt could not be confirmed; retry using the same reference",
      },
      503,
    );
  }
});
