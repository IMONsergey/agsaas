import { verifyFileKey } from "@midday/encryption";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { normalizeAndValidatePath } from "../routers/files/utils";
import type { Context } from "../types";

export const withFileAuth = (
  pathParameter: "filePath" | "path",
): MiddlewareHandler<Context> => async (c, next) => {
  const fk = c.req.query("fk");

  if (!fk) {
    throw new HTTPException(401, {
      message: "File key (fk) query parameter is required for file access.",
    });
  }

  // Authorize exactly the parameter consumed by this route, not an alias that
  // could be supplied alongside a different download path.
  const paths = c.req.queries(pathParameter);
  const filePath = paths?.[0];

  if (!filePath || paths?.length !== 1) {
    throw new HTTPException(400, {
      message: "File path is required.",
    });
  }

  // Extract teamId from path
  const { pathTeamId, normalizedPath } = normalizeAndValidatePath(filePath);

  // Verify JWT token and extract teamId
  const tokenTeamId = await verifyFileKey(fk);

  // Validate the token's teamId matches the path teamId
  if (!tokenTeamId || tokenTeamId !== pathTeamId) {
    throw new HTTPException(401, {
      message: "Invalid file key.",
    });
  }

  // Set teamId in context for downstream handlers
  c.set("teamId", pathTeamId);
  c.set("authorizedFilePath", normalizedPath);

  await next();
};
