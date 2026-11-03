import {
  attachOwnedTeamConnector,
  reserveOwnedTeamConnector,
} from "@api/composio/authorizations";
import { getCatalog } from "@api/composio/catalog";
import {
  composio,
  composioFetch,
  extractActiveConnections,
  getTeamToolkits,
  invalidateTeamToolkitsCache,
  type ToolkitDetail,
  type ToolsResponse,
} from "@api/composio/client";
import {
  composioTeamEntityId,
  connectorCallbackUrl,
} from "@api/composio/tenant";
import {
  createTRPCRouter,
  ownerProcedure,
  protectedProcedure,
} from "@api/trpc/init";
import { CURATED_TOOLKIT_SLUGS } from "@midday/connectors";
import {
  listTeamConnectors,
  markTeamConnectorDisconnecting,
  retainResourceCleanup,
} from "@midday/db/queries";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "@midday/db/utils/team-membership";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const connectorsRouter = createTRPCRouter({
  list: protectedProcedure.query(async () => {
    return getCatalog();
  }),

  connections: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    if (!teamId || !process.env.COMPOSIO_API_KEY?.trim()) return [];
    const reservations = await listTeamConnectors(db, teamId);
    const active = extractActiveConnections(await getTeamToolkits(teamId));
    for (const connection of active) {
      const reservation = reservations.find(
        (row) =>
          row.toolkit === connection.slug &&
          ["pending", "unknown"].includes(row.status),
      );
      if (reservation && connection.connectedAccountId)
        await attachOwnedTeamConnector(
          db,
          reservation,
          connection.connectedAccountId,
        );
    }
    const allowed = await listTeamConnectors(db, teamId);
    return active.filter((connection) =>
      allowed.some(
        (row) =>
          row.status === "active" &&
          row.providerAccountId === connection.connectedAccountId,
      ),
    );
  }),

  attempts: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    if (!teamId) return [];
    return (await listTeamConnectors(db, teamId)).map((row) => ({
      id: row.id,
      toolkit: row.toolkit,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }),

  detail: protectedProcedure
    .input(z.object({ slug: z.string().regex(/^[a-z0-9_]{1,64}$/) }))
    .query(async ({ input }) => {
      const [toolkit, toolsData] = await Promise.all([
        composioFetch<ToolkitDetail>(`/toolkits/${input.slug}`),
        composioFetch<ToolsResponse>(
          `/tools?toolkit_slug=${input.slug}&important=true&limit=20`,
        ),
      ]);

      return {
        slug: toolkit.slug,
        name: toolkit.name,
        description: toolkit.meta.description,
        logo: toolkit.meta.logo,
        appUrl: toolkit.meta.app_url,
        categories: toolkit.meta.categories,
        toolsCount: toolkit.meta.tools_count,
        triggersCount: toolkit.meta.triggers_count,
        authSchemes: toolkit.composio_managed_auth_schemes,
        tools: toolsData.items.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.human_description || t.description,
          tags: t.tags,
        })),
      };
    }),

  authorize: ownerProcedure
    .input(
      z
        .object({
          toolkit: z.string().regex(/^[a-z0-9_]{1,64}$/),
          callbackUrl: z.string().url().max(2048).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      if (!teamId || !process.env.COMPOSIO_API_KEY?.trim())
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "AI connectors are not configured",
        });
      if (
        !CURATED_TOOLKIT_SLUGS.includes(
          input.toolkit as (typeof CURATED_TOOLKIT_SLUGS)[number],
        )
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Toolkit is not available",
        });
      let callbackUrl: string;
      try {
        callbackUrl = connectorCallbackUrl(input.callbackUrl);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Use this installation's connector callback",
        });
      }
      const reservation = await reserveOwnedTeamConnector(db, {
        teamId,
        toolkit: input.toolkit,
        actorId: session.user.id,
      });
      if (!reservation.created)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "A connector attempt already exists. Refresh connection status or reconcile that attempt before starting another.",
        });
      // Persist reservation before HTTP. Ambiguous provider responses retain quota and are never blindly retried.
      const composioSession = await composio.create(
        composioTeamEntityId(teamId),
      );
      const request = await composioSession.authorize(input.toolkit, {
        callbackUrl,
      });
      const redirectUrl = new URL(request.redirectUrl ?? "");
      if (
        redirectUrl.protocol !== "https:" ||
        redirectUrl.hostname !== "connect.composio.dev"
      )
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "Provider authorization could not be confirmed",
        });
      await db.transaction(async (tx) => {
        await lockUserMembership(tx, session.user.id);
        requireTeamOwner(await lockTeamMembership(tx, teamId), session.user.id);
        const retained = (await listTeamConnectors(tx, teamId)).find(
          (row) => row.id === reservation.id && row.status === "pending",
        );
        if (!retained)
          throw new TRPCError({
            code: "CONFLICT",
            message: "Connector authorization is no longer valid",
          });
      });
      await invalidateTeamToolkitsCache(teamId);
      return { redirectUrl: redirectUrl.href, reservationId: reservation.id };
    }),

  disconnect: ownerProcedure
    .input(
      z
        .object({
          connectedAccountId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
        })
        .strict(),
    )
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      if (!teamId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const reservation = (await listTeamConnectors(db, teamId)).find(
        (row) =>
          row.providerAccountId === input.connectedAccountId &&
          ["active", "disconnecting"].includes(row.status),
      );
      if (!reservation)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Connector does not belong to this workspace",
        });
      const cleanup = await db.transaction(async (tx) => {
        await lockUserMembership(tx, session.user.id);
        requireTeamOwner(await lockTeamMembership(tx, teamId), session.user.id);
        await markTeamConnectorDisconnecting(tx, {
          teamId,
          providerAccountId: input.connectedAccountId,
        });
        return retainResourceCleanup(tx, {
          version: 1,
          kind: "provider",
          teamId,
          actorUserId: session.user.id,
          targetId: reservation.id,
          provider: "composio",
          data: {
            externalId: input.connectedAccountId,
            entityId: composioTeamEntityId(teamId),
            toolkit: reservation.toolkit,
            reservationId: reservation.id,
          },
        });
      });
      await invalidateTeamToolkitsCache(teamId);
      return {
        success: true,
        cleanupPending: cleanup.status !== "completed",
        cleanupId: cleanup.id,
      };
    }),
});
