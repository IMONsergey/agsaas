import { toPublicApp } from "@midday/db/public-app";
import {
  createPlatformLinkTokenSchema,
  disconnectAppSchema,
  removeWhatsAppConnectionSchema,
  updateAppSettingsSchema,
} from "@api/schemas/apps";
import { createTRPCRouter, ownerProcedure, protectedProcedure } from "@api/trpc/init";
import { getInstanceCapabilities } from "@api/utils/instance-capabilities";
import {
  createPlatformLinkToken,
  disconnectApp,
  getApps,
  removeWhatsAppConnection,
  updateAppSettings,
  updateAppSettingsBulk,
} from "@midday/db/queries";
import { z } from "zod";

export const appsRouter = createTRPCRouter({
  capabilities: protectedProcedure.query(() => getInstanceCapabilities()),
  get: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return (await getApps(db, teamId!)).map((app) => toPublicApp(app));
  }),

  disconnect: ownerProcedure
    .input(disconnectAppSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId } = input;

      return toPublicApp(await disconnectApp(db, { appId, teamId: teamId! }));
    }),

  update: ownerProcedure
    .input(updateAppSettingsSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId, option } = input;

      return toPublicApp(await updateAppSettings(db, {
        appId,
        teamId: teamId!,
        option,
      }));
    }),

  updateSettings: ownerProcedure
    .input(
      z.object({
        appId: z.string(),
        settings: z.array(
          z.object({
            id: z.string(),
            label: z.string().optional(),
            description: z.string().optional(),
            type: z.string().optional(),
            required: z.boolean().optional(),
            value: z.unknown(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { appId, settings } = input;

      return toPublicApp(await updateAppSettingsBulk(db, {
        appId,
        teamId: teamId!,
        settings,
      }));
    }),

  removeWhatsAppConnection: ownerProcedure
    .input(removeWhatsAppConnectionSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const { phoneNumber } = input;

      await removeWhatsAppConnection(db, {
        teamId: teamId!,
        phoneNumber,
      });
      return { success: true };
    }),

  createPlatformLinkToken: protectedProcedure
    .input(createPlatformLinkTokenSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return createPlatformLinkToken(db, {
        provider: input.provider,
        teamId: teamId!,
        userId: session.user.id,
      });
    }),
});
