import { and, desc, eq, sql } from "drizzle-orm";
import type {
  AppConfigFor,
  TelegramConnection,
  WhatsAppConnection,
} from "../app-config";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import {
  TelegramAlreadyConnectedToAnotherTeamError,
  WhatsAppAlreadyConnectedToAnotherTeamError,
} from "../errors";
import { toPublicApp } from "../public-app";
import { apps, platformIdentities } from "../schema";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamMember,
  requireTeamOwner,
} from "../utils/team-membership";
import {
  assertNoPendingProviderCleanup,
  retainAppCleanup,
} from "./resource-cleanups";
import { appendSecurityAuditEvent } from "./security-audit";

async function auditAppMutation<T>(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    appId: string;
    actorUserId?: string;
    operation: string;
    ownerRequired?: boolean;
    metadata?: Record<string, unknown>;
  },
  write: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (input.actorUserId) {
      await lockUserMembership(tx, input.actorUserId);
      const members = await lockTeamMembership(tx, input.teamId);
      if (input.ownerRequired !== false)
        requireTeamOwner(members, input.actorUserId);
      else requireTeamMember(members, input.actorUserId);
    }
    const result = await write(tx);
    await appendSecurityAuditEvent(tx, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      operation: input.operation,
      targetType: "integration",
      targetId: input.appId,
      metadata: { provider: input.appId, ...input.metadata },
    });
    return result;
  });
}

export type AppRecord<TAppId extends string = string> = Omit<
  typeof apps.$inferSelect,
  "appId" | "config"
> & {
  appId: TAppId;
  config: AppConfigFor<TAppId> | null;
};

export type CreateAppParams<TAppId extends string = string> = {
  teamId: string;
  createdBy: string;
  appId: TAppId;
  settings?: unknown;
  config?: AppConfigFor<TAppId>;
};

export const createApp = async <TAppId extends string>(
  db: DatabaseOrTransaction,
  params: CreateAppParams<TAppId>,
): Promise<AppRecord<TAppId> | undefined> => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: params.appId,
      actorUserId: params.createdBy,
      operation: "integration.connect",
      metadata: { connected: true, configurationChanged: true },
    },
    async (tx) => {
      const config = params.config as Record<string, unknown> | undefined;
      const externalId =
        config &&
        ["tenantId", "realmId", "companyId", "team_id"]
          .map((key) => config[key])
          .find((value) => typeof value === "string");
      await assertNoPendingProviderCleanup(
        tx,
        params.teamId,
        params.appId,
        typeof externalId === "string" ? externalId : undefined,
      );
      const [result] = await tx
        .insert(apps)
        .values({
          teamId: params.teamId,
          createdBy: params.createdBy,
          appId: params.appId,
          settings: params.settings,
          config: params.config,
        })
        .onConflictDoUpdate({
          target: [apps.teamId, apps.appId],
          set: {
            config: params.config,
            settings: params.settings,
          },
        })
        .returning();

      return result as AppRecord<TAppId> | undefined;
    },
  );
};

type AppSetting = {
  id: string;
  value: string | number | boolean;
  [key: string]: unknown;
};

export const getApps = async (db: DatabaseOrTransaction, teamId: string) => {
  const result = await db
    .select({
      app_id: apps.appId,
      settings: apps.settings,
      config: apps.config,
    })
    .from(apps)
    .where(eq(apps.teamId, teamId));

  return result.map((app) => toPublicApp(app));
};

export type GetAppByAppIdParams<TAppId extends string = string> = {
  appId: TAppId;
  teamId: string;
};

export const getAppByAppId = async <TAppId extends string>(
  db: DatabaseOrTransaction,
  params: GetAppByAppIdParams<TAppId>,
): Promise<AppRecord<TAppId> | null> => {
  const [result] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.appId, params.appId), eq(apps.teamId, params.teamId)))
    .limit(1);

  return (result as AppRecord<TAppId> | undefined) ?? null;
};

export type GetAppBySlackTeamIdParams = {
  slackTeamId: string;
  channelId?: string; // Optional channel ID to help disambiguate if same Slack workspace connected to multiple Midday teams
};

export const getAppBySlackTeamId = async (
  db: DatabaseOrTransaction,
  params: GetAppBySlackTeamIdParams,
) => {
  const { slackTeamId, channelId } = params;

  // Base conditions for Slack app with matching team_id
  const baseConditions = [
    eq(apps.appId, "slack"),
    sql`${apps.config}->>'team_id' = ${slackTeamId}`,
  ];

  // When channelId is provided, look for exact match only (no fallback)
  if (channelId) {
    const results = await db
      .select()
      .from(apps)
      .where(
        and(
          ...baseConditions,
          sql`${apps.config}->>'channel_id' = ${channelId}`,
        ),
      )
      .limit(1);

    const result = (results[0] as AppRecord<"slack"> | undefined) ?? null;

    if (!result) {
      // Log for debugging - but do NOT fall back to prevent cross-tenant issues
      console.info(
        `No Slack integration found for team_id=${slackTeamId} with channel_id=${channelId}`,
      );
    }

    return result;
  }

  // When channelId is NOT provided, we must ensure there's no ambiguity
  // Query all integrations for this Slack workspace
  const allResults = (await db
    .select()
    .from(apps)
    .where(and(...baseConditions))
    .orderBy(desc(apps.createdAt))) as AppRecord<"slack">[];

  // SECURITY: If multiple integrations exist, we cannot safely determine which one
  // to use without a channelId. Return null to fail safely.
  if (allResults.length > 1) {
    console.error(
      "SECURITY: Multiple Slack integrations found for Slack team. Cannot determine correct Midday team without channel_id. Returning null to prevent cross-tenant issues.",
      {
        slackTeamId,
        count: allResults.length,
        middayTeamIds: allResults.map((r) => r.teamId),
        channelIds: allResults.map((r) => r.config?.channel_id),
      },
    );
    return null;
  }

  // Only one integration exists - safe to return
  return allResults[0] || null;
};

export type DisconnectAppParams = {
  actorUserId?: string;
  appId: string;
  teamId: string;
};

export const disconnectApp = async (
  db: DatabaseOrTransaction,
  params: DisconnectAppParams,
) => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: params.appId,
      actorUserId: params.actorUserId,
      operation: "integration.disconnect",
      metadata: { connected: false },
    },
    async (tx) => {
      const { appId, teamId } = params;
      const [installed] = await tx
        .select()
        .from(apps)
        .where(and(eq(apps.appId, appId), eq(apps.teamId, teamId)))
        .for("update");
      const cleanup = installed
        ? await retainAppCleanup(tx, {
            ...installed,
            teamId,
            appId,
            actorUserId: params.actorUserId,
          })
        : null;

      if (appId === "slack" || appId === "telegram" || appId === "whatsapp") {
        await tx
          .delete(platformIdentities)
          .where(
            and(
              eq(platformIdentities.teamId, teamId),
              eq(platformIdentities.provider, appId),
            ),
          );
      }

      const deleted = await tx
        .delete(apps)
        .where(and(eq(apps.appId, appId), eq(apps.teamId, teamId)))
        .returning();

      return deleted[0]
        ? {
            ...deleted[0],
            cleanupPending: !!cleanup && cleanup.status !== "completed",
            cleanupId: cleanup?.id ?? null,
          }
        : null;
    },
  );
};

export type UpdateAppSettingsParams = {
  actorUserId?: string;
  appId: string;
  teamId: string;
  option: {
    id: string;
    value: string | number | boolean;
  };
};

export const updateAppSettings = async (
  db: DatabaseOrTransaction,
  params: UpdateAppSettingsParams,
) => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: params.appId,
      actorUserId: params.actorUserId,
      operation: "integration.settings",
      metadata: { settingsChanged: true, settingIds: [params.option.id] },
    },
    async (tx) => {
      const { appId, teamId, option } = params;

      // First fetch the existing app
      const existingApps = await tx
        .select({ settings: apps.settings })
        .from(apps)
        .where(and(eq(apps.appId, appId), eq(apps.teamId, teamId)));

      if (!existingApps.length) {
        throw new Error("App not found");
      }

      const existingApp = existingApps[0]!;

      const settings = (existingApp.settings as AppSetting[]) || [];

      // Update the settings
      const updatedSettings = settings.map((setting: AppSetting) => {
        if (setting.id === option.id) {
          return { ...setting, value: option.value };
        }
        return setting;
      });

      // Update the record
      const [result] = await tx
        .update(apps)
        .set({ settings: updatedSettings })
        .where(and(eq(apps.appId, appId), eq(apps.teamId, teamId)))
        .returning();

      if (!result) {
        throw new Error("Failed to update app settings");
      }

      return result;
    },
  );
};

export type UpdateAppSettingsBulkParams = {
  actorUserId?: string;
  appId: string;
  teamId: string;
  settings: Array<{
    id: string;
    value: unknown;
    [key: string]: unknown;
  }>;
};

/**
 * Update all settings for an app at once
 */
export const updateAppSettingsBulk = async (
  db: DatabaseOrTransaction,
  params: UpdateAppSettingsBulkParams,
) => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: params.appId,
      actorUserId: params.actorUserId,
      operation: "integration.settings",
      metadata: {
        settingsChanged: true,
        settingIds: params.settings.map((item) => item.id),
      },
    },
    async (tx) => {
      const { appId, teamId, settings } = params;

      // Update the record directly with new settings
      const [result] = await tx
        .update(apps)
        .set({ settings })
        .where(and(eq(apps.appId, appId), eq(apps.teamId, teamId)))
        .returning();

      if (!result) {
        throw new Error("Failed to update app settings");
      }

      return result;
    },
  );
};

export type DeleteAppParams = {
  appId: string;
  teamId: string;
};

/**
 * Delete an app (alias for disconnectApp for semantic clarity)
 */
export const deleteApp = async (
  db: DatabaseOrTransaction,
  params: DeleteAppParams,
) => {
  return disconnectApp(db, params);
};

/**
 * Find team by WhatsApp phone number
 * Searches all WhatsApp app installations for a matching phone number in connections
 */
export const getAppByWhatsAppNumber = async (
  db: DatabaseOrTransaction,
  phoneNumber: string,
) => {
  const results = (await db
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.appId, "whatsapp"),
        sql`${apps.config}->'connections' @> ${JSON.stringify([{ phoneNumber }])}::jsonb`,
      ),
    )) as AppRecord<"whatsapp">[];

  return results[0] || null;
};

export type AddWhatsAppConnectionParams = {
  teamId: string;
  phoneNumber: string;
  displayName?: string;
  createdBy?: string;
};

/**
 * Add a WhatsApp connection to a team
 * Creates the WhatsApp app if it doesn't exist, or adds to existing connections
 */
export const addWhatsAppConnection = async (
  db: DatabaseOrTransaction,
  params: AddWhatsAppConnectionParams,
) => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: "whatsapp",
      actorUserId: params.createdBy,
      ownerRequired: false,
      operation: "integration.identity_link",
      metadata: { connected: true },
    },
    async (tx) => {
      const {
        teamId,
        phoneNumber,
        displayName,
        createdBy: linkingUserId,
      } = params;

      // Check if this phone number is already connected to any team
      const existingConnection = await getAppByWhatsAppNumber(tx, phoneNumber);
      if (existingConnection) {
        // If already connected to this team, just return success
        if (existingConnection.teamId === teamId) {
          return existingConnection;
        }
        // If connected to a different team, throw error
        throw new WhatsAppAlreadyConnectedToAnotherTeamError();
      }

      // Get existing WhatsApp app for this team
      const existingApp = await getAppByAppId(tx, {
        appId: "whatsapp",
        teamId,
      });

      const newConnection: WhatsAppConnection = {
        phoneNumber,
        displayName,
        connectedAt: new Date().toISOString(),
      };

      if (existingApp) {
        // Add to existing connections
        const config = existingApp.config ?? {};
        const connections = config.connections || [];

        const [result] = await tx
          .update(apps)
          .set({
            config: {
              ...config,
              connections: [...connections, newConnection],
            },
          })
          .where(and(eq(apps.appId, "whatsapp"), eq(apps.teamId, teamId)))
          .returning();

        return result;
      }

      const createdBy = linkingUserId;
      if (!createdBy)
        throw new Error("An authenticated linking actor is required");

      // Create new WhatsApp app with this connection
      const [result] = await tx
        .insert(apps)
        .values({
          teamId,
          appId: "whatsapp",
          createdBy,
          config: {
            connections: [newConnection],
          },
          settings: [
            { id: "receipts", label: "Receipt Processing", value: true },
            { id: "matches", label: "Match Notifications", value: true },
          ],
        })
        .returning();

      return result as AppRecord<"whatsapp">;
    },
  );
};

export type RemoveWhatsAppConnectionParams = {
  actorUserId?: string;
  teamId: string;
  phoneNumber: string;
};

/**
 * Remove a WhatsApp connection from a team
 */
export const removeWhatsAppConnection = async (
  db: DatabaseOrTransaction,
  params: RemoveWhatsAppConnectionParams,
) => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: "whatsapp",
      actorUserId: params.actorUserId,
      operation: "integration.identity_unlink",
      metadata: { configurationChanged: true },
    },
    async (tx) => {
      const { teamId, phoneNumber } = params;

      await tx
        .delete(platformIdentities)
        .where(
          and(
            eq(platformIdentities.teamId, teamId),
            eq(platformIdentities.provider, "whatsapp"),
            eq(platformIdentities.externalUserId, phoneNumber),
            eq(platformIdentities.externalTeamId, ""),
          ),
        );

      const existingApp = await getAppByAppId(tx, {
        appId: "whatsapp",
        teamId,
      });

      if (!existingApp) {
        throw new Error("WhatsApp app not found for this team");
      }

      const config = existingApp.config ?? {};
      const connections = config.connections || [];

      const updatedConnections = connections.filter(
        (c) => c.phoneNumber !== phoneNumber,
      );

      // If no connections left, delete the app entirely
      if (updatedConnections.length === 0) {
        await tx
          .delete(apps)
          .where(and(eq(apps.appId, "whatsapp"), eq(apps.teamId, teamId)));
        return null;
      }

      // Update with remaining connections
      const [result] = await tx
        .update(apps)
        .set({
          config: {
            ...config,
            connections: updatedConnections,
          },
        })
        .where(and(eq(apps.appId, "whatsapp"), eq(apps.teamId, teamId)))
        .returning();

      return result;
    },
  );
};

/**
 * Get all WhatsApp connections for a team
 */
export const getWhatsAppConnections = async (
  db: DatabaseOrTransaction,
  teamId: string,
) => {
  const app = await getAppByAppId(db, { appId: "whatsapp", teamId });

  if (!app) {
    return [];
  }

  const config = app.config ?? {};
  return config.connections || [];
};

export const getAppByTelegramUserId = async (
  db: DatabaseOrTransaction,
  telegramUserId: string,
) => {
  const results = (await db
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.appId, "telegram"),
        sql`${apps.config}->'connections' @> ${JSON.stringify([{ userId: telegramUserId }])}::jsonb`,
      ),
    )) as AppRecord<"telegram">[];

  return results[0] || null;
};

export type AddTelegramConnectionParams = {
  teamId: string;
  userId: string;
  chatId: string;
  username?: string;
  displayName?: string;
  createdBy?: string;
};

export const addTelegramConnection = async (
  db: DatabaseOrTransaction,
  params: AddTelegramConnectionParams,
) => {
  return auditAppMutation(
    db,
    {
      teamId: params.teamId,
      appId: "telegram",
      actorUserId: params.createdBy,
      ownerRequired: false,
      operation: "integration.identity_link",
      metadata: { connected: true },
    },
    async (tx) => {
      const {
        teamId,
        userId,
        chatId,
        username,
        displayName,
        createdBy: linkingUserId,
      } = params;

      const existingConnection = await getAppByTelegramUserId(tx, userId);
      if (existingConnection) {
        if (existingConnection.teamId === teamId) {
          return existingConnection;
        }

        throw new TelegramAlreadyConnectedToAnotherTeamError();
      }

      const existingApp = await getAppByAppId(tx, {
        appId: "telegram",
        teamId,
      });

      const newConnection: TelegramConnection = {
        userId,
        chatId,
        username,
        displayName,
        connectedAt: new Date().toISOString(),
      };

      if (existingApp) {
        const config = existingApp.config ?? {};
        const connections = config.connections || [];

        const [result] = await tx
          .update(apps)
          .set({
            config: {
              ...config,
              connections: [...connections, newConnection],
            },
          })
          .where(and(eq(apps.appId, "telegram"), eq(apps.teamId, teamId)))
          .returning();

        return result;
      }

      const createdBy = linkingUserId;
      if (!createdBy)
        throw new Error("An authenticated linking actor is required");

      const [result] = await tx
        .insert(apps)
        .values({
          teamId,
          appId: "telegram",
          createdBy,
          config: {
            connections: [newConnection],
          },
          settings: [
            { id: "receipts", label: "Receipt Processing", value: true },
            { id: "matches", label: "Match Notifications", value: true },
          ],
        })
        .returning();

      return result as AppRecord<"telegram">;
    },
  );
};

export const getTelegramConnections = async (
  db: DatabaseOrTransaction,
  teamId: string,
) => {
  const app = await getAppByAppId(db, { appId: "telegram", teamId });

  if (!app) {
    return [];
  }

  const config = app.config ?? {};
  return config.connections || [];
};

export type UpdateAppTokensParams = {
  teamId: string;
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

/**
 * Update OAuth tokens for an app (atomic operation)
 * Used for token refresh in accounting integrations (Xero, QuickBooks, etc.)
 * Uses JSONB merge to preserve other config fields
 */
export const updateAppTokens = async (
  db: DatabaseOrTransaction,
  params: UpdateAppTokensParams,
) => {
  const { teamId, appId, accessToken, refreshToken, expiresAt } = params;

  // Use SQL JSONB concatenation for atomic merge
  const [result] = await db
    .update(apps)
    .set({
      config: sql`COALESCE(${apps.config}, '{}'::jsonb) || ${JSON.stringify({
        accessToken,
        refreshToken,
        expiresAt,
      })}::jsonb`,
    })
    .where(and(eq(apps.appId, appId), eq(apps.teamId, teamId)))
    .returning();

  if (!result) {
    throw new Error(`Failed to update tokens for app ${appId}`);
  }

  return result;
};
