import type { Session } from "@api/utils/auth";
import { withRetryOnPrimary } from "@api/utils/db-retry";
import { MfaPolicyError, requireSessionMfa } from "@api/utils/mfa";
import type { Database, DatabaseWithPrimary } from "@midday/db/client";
import { createLoggerWithContext } from "@midday/logger";
import { TRPCError } from "@trpc/server";

const DEBUG_PERF = process.env.DEBUG_PERF === "true";
const perfLogger = createLoggerWithContext("perf:trpc");
const teamPermissionLogger = createLoggerWithContext("trpc:team-permission");

type TeamResolution = {
  teamId: string | null;
};

const resolveCache = new WeakMap<object, Promise<TeamResolution>>();

async function resolveTeamPermission(
  session: Session | undefined | null,
  db: Database,
  procedurePath?: string,
  requestId?: string,
  cfRay?: string,
): Promise<TeamResolution> {
  const resolveStart = DEBUG_PERF ? performance.now() : 0;
  const userId = session?.user?.id;

  if (!userId) {
    teamPermissionLogger.warn("permission denied: missing user id", {
      procedurePath,
      hasSession: !!session,
      requestId,
      cfRay,
    });
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "No permission to access this team",
    });
  }

  const dbStart = DEBUG_PERF ? performance.now() : 0;
  // Membership is an authorization boundary: a replica or cached allow must
  // not outlive revocation. Request-local resolution is still deduplicated.
  const primaryOnly = (db as DatabaseWithPrimary).usePrimaryOnly;
  const authDb = primaryOnly ? primaryOnly.call(db) : db;
  const result = await withRetryOnPrimary(
    authDb,
    async (db) => {
      return await db.query.users.findFirst({
        with: {
          usersOnTeams: {
            columns: {
              id: true,
              teamId: true,
            },
          },
        },
        where: (users, { eq }) => eq(users.id, userId),
      });
    },
    { retryOnNull: true },
  );
  const dbMs = DEBUG_PERF ? performance.now() - dbStart : 0;

  if (!result) {
    teamPermissionLogger.warn("permission denied: user not found", {
      procedurePath,
      userId,
      requestId,
      cfRay,
    });
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "User not found",
    });
  }

  const teamId = result.teamId;

  await requireTrpcSessionMfa(session!);

  if (teamId !== null) {
    const hasAccess = result.usersOnTeams.some(
      (membership) => membership.teamId === teamId,
    );

    if (!hasAccess) {
      teamPermissionLogger.warn("permission denied: user has no team access", {
        procedurePath,
        userId,
        teamId,
        requestId,
        cfRay,
      });
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No permission to access this team",
      });
    }
  }

  if (DEBUG_PERF) {
    perfLogger.info("teamPermission", {
      totalMs: +(performance.now() - resolveStart).toFixed(2),
      dbQueryMs: +dbMs.toFixed(2),
      teamId,
    });
  }

  return { teamId };
}

export async function requireTrpcSessionMfa(session: Session) {
  try {
    await requireSessionMfa(session);
  } catch (error) {
    if (error instanceof MfaPolicyError) {
      throw new TRPCError({
        code: error.reason === "required" ? "FORBIDDEN" : "SERVICE_UNAVAILABLE",
        message: error.message,
      });
    }
    throw error;
  }
}

export const withTeamPermission = async <TReturn>(opts: {
  ctx: {
    session?: Session | null;
    db: Database;
    requestId?: string;
    cfRay?: string;
  };
  procedurePath?: string;
  next: (opts: {
    ctx: {
      session?: Session | null;
      db: Database;
      teamId: string | null;
    };
  }) => Promise<TReturn>;
}) => {
  const { ctx, next } = opts;

  let resolution = resolveCache.get(ctx);
  if (!resolution) {
    resolution = resolveTeamPermission(
      ctx.session,
      ctx.db,
      opts.procedurePath,
      ctx.requestId,
      ctx.cfRay,
    );
    resolveCache.set(ctx, resolution);
  }

  const { teamId } = await resolution;

  return next({
    ctx: {
      session: ctx.session,
      teamId,
      db: ctx.db,
    },
  });
};
