import { requireFileAccess } from "@api/utils/file-access";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { normalizeAndValidatePath } from "../routers/files/utils";

export const withFileAuth: MiddlewareHandler = async (c, next) => {
  // Get filePath from query - this will be validated by the route schema
  const filePath = c.req.query("filePath") || c.req.query("path");

  if (!filePath) {
    throw new HTTPException(400, {
      message: "File path is required.",
    });
  }

  // Extract teamId from path
  const { pathTeamId, pathArray } = normalizeAndValidatePath(filePath);
  const access = await requireFileAccess(
    c,
    pathArray[1] === "invoices" ? "invoices.read" : "documents.read",
  );

  // Validate the token's teamId matches the path teamId
  if (access.teamId !== pathTeamId) {
    throw new HTTPException(401, {
      message: "No permission to access this file.",
    });
  }

  // Set teamId in context for downstream handlers
  c.set("teamId", pathTeamId);

  await next();
};
