import type { Database } from "@midday/db/client";
import {
  consumeRequestBudget,
  ResourceBudgetExceededError,
} from "@midday/db/queries/resource-admission";
import { TRPCError } from "@trpc/server";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

const admissionContextKey = "agsaasResourceAdmissionGranted";
type AdmittedIdentity = { userId: string; teamId: string | null };

/** Call only after the file identity's ownership, session and MFA are verified. */
export async function admitFileRequest(
  c: Context,
  identity: { userId: string; teamId: string },
) {
  const admitted = c.get(admissionContextKey) as AdmittedIdentity | undefined;
  if (
    admitted?.userId === identity.userId &&
    admitted.teamId === identity.teamId
  )
    return;
  try {
    await consumeRequestBudget(c.get("db"), {
      userId: identity.userId,
      teamId: identity.teamId,
      cost: 1,
    });
  } catch (error) {
    if (error instanceof ResourceBudgetExceededError)
      throw new HTTPException(429, {
        res: c.json(
          { code: "RATE_LIMIT_EXCEEDED", error: error.message },
          429,
          { "Retry-After": "60" },
        ),
      });
    throw new HTTPException(503, {
      res: c.json(
        {
          code: "ADMISSION_UNAVAILABLE",
          error: "Request admission is temporarily unavailable",
        },
        503,
      ),
    });
  }
  c.set(admissionContextKey, {
    userId: identity.userId,
    teamId: identity.teamId,
  } satisfies AdmittedIdentity);
}

export async function admitTrpcRequest(
  db: Database,
  input: { userId: string; teamId?: string | null; path: string; type: string },
) {
  const expensive =
    /(^|\.)(export|import|process|reprocess|sync|enrich|generate)/i.test(
      input.path,
    );
  try {
    await consumeRequestBudget(db, {
      userId: input.userId,
      teamId: input.teamId,
      cost: expensive ? 20 : input.type === "mutation" ? 5 : 1,
    });
  } catch (error) {
    if (error instanceof ResourceBudgetExceededError)
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: error.message,
      });
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Request admission is temporarily unavailable",
    });
  }
}

export const withResourceAdmission: MiddlewareHandler = async (c, next) => {
  const session = c.get("session");
  if (!session?.user?.id) return c.json({ code: "UNAUTHORIZED" }, 401);
  const cost = /\/(chat|export|import|process|sync)(\/|$)/.test(c.req.path)
    ? 20
    : ["POST", "PUT", "DELETE", "PATCH"].includes(c.req.method)
      ? 5
      : 1;
  try {
    await consumeRequestBudget(c.get("db"), {
      userId: session.user.id,
      teamId: c.get("teamId"),
      cost,
    });
    c.set(admissionContextKey, {
      userId: session.user.id,
      teamId: c.get("teamId") ?? null,
    } satisfies AdmittedIdentity);
  } catch (error) {
    if (error instanceof ResourceBudgetExceededError) {
      c.header("Retry-After", "60");
      return c.json({ code: "RATE_LIMIT_EXCEEDED", error: error.message }, 429);
    }
    return c.json(
      {
        code: "ADMISSION_UNAVAILABLE",
        error: "Request admission is temporarily unavailable",
      },
      503,
    );
  }
  await next();
};
