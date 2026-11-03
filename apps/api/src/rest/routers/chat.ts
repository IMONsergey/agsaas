import { withRequiredScope } from "@api/rest/middleware/scope";
import { bodyLimit } from "hono/body-limit";
import { streamMiddayAssistant } from "@api/chat/assistant-runtime";
import type { MentionedApp } from "@api/chat/prompt";
import { buildSystemPrompt } from "@api/chat/prompt";
import {
  decodeDataUrl,
  stripFileAndImageParts,
  writeChatTitle,
} from "@api/chat/utils";
import type { McpContext } from "@api/mcp/types";
import type { Context } from "@api/rest/types";
import { getGeoContext } from "@api/utils/geo";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  formatProcessedUploadSummary,
  getPlatformInstructions,
  isSupportedInboxUploadMediaType,
  processInboxUpload,
} from "@midday/bot";
import { logger } from "@midday/logger";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { type RateLimitInfo, rateLimiter } from "hono-rate-limiter";

type ChatContext = {
  Variables: Context["Variables"] & {
    rateLimit: RateLimitInfo;
  };
};

const app = new OpenAPIHono<ChatContext>();

app.use(
  rateLimiter<ChatContext>({
    windowMs: 10 * 60 * 1000,
    limit: Number(process.env.CHAT_RATE_LIMIT) || 100,
    keyGenerator: (c) => c.get("session")?.user?.id ?? "unknown",
    handler: (c) =>
      c.json(
        { code: "RATE_LIMIT_EXCEEDED", error: "Chat rate limit exceeded" },
        429,
      ),
  }),
);

// Authentication middleware sets scopes/authType from verified credentials.
// These gates precede body parsing, file decoding, Storage, queues and AI tools.
app.use(withRequiredScope("chat.write"));
app.use(async (c, next) => {
  if (!c.get("teamId")) return c.json({ code: "TEAM_REQUIRED", error: "Select a team before using chat" }, 403);
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return c.json({ code: "AI_NOT_CONFIGURED", error: "AI is not configured for this instance" }, 503);
  }
  await next();
});
app.use(bodyLimit({ maxSize: 20 * 1024 * 1024, onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", error: "Chat request is too large" }, 413) }));

app.post("/", async (c) => {
  try {
    const db = c.get("db");
    const teamId = c.get("teamId");
    const session = c.get("session");
    const scopes = c.get("scopes") ?? [];
    const geo = getGeoContext(c.req);
    const user = c.get("user");

    let body: Record<string, any>;
    try { body = await c.req.json(); } catch { return c.json({ code: "INVALID_REQUEST", error: "Invalid chat request" }, 400); }
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100 || body.messages.some((message: any) => !message || !["user", "assistant", "system"].includes(message.role) || !Array.isArray(message.parts) || message.parts.length > 100)) {
      return c.json({ code: "INVALID_REQUEST", error: "Invalid chat messages" }, 400);
    }
    const uiMessages = body.messages as any[];
    const latestUserMessage = [...uiMessages]
      .reverse()
      .find((message) => message?.role === "user");

    const clientTimezone = (body.timezone as string) || null;
    const clientLocalTime = (body.localTime as string) || null;
    const resolvedTimezone =
      user?.timezone || clientTimezone || geo.timezone || "UTC";

    const mcpCtx: McpContext = {
      db,
      teamId,
      userId: user?.id ?? session.user.id,
      sessionId: c.get("authType") === "session" ? session.sessionId : undefined,
      userEmail: user?.email ?? session.user.email ?? null,
      scopes,
      apiUrl: process.env.MIDDAY_API_URL || "https://api.midday.ai",
      timezone: resolvedTimezone,
      locale: user?.locale || geo.locale,
      countryCode: geo.country,
      dateFormat: user?.dateFormat ?? null,
      timeFormat: user?.timeFormat ?? null,
    };

    const mentionedApps =
      (body.mentionedApps as MentionedApp[] | undefined) ?? [];

    const recentUploadSummaries: string[] = [];

    if (latestUserMessage?.parts) {
      const fileParts = latestUserMessage.parts.filter(
        (part: any) =>
          part?.type === "file" &&
          typeof part?.url === "string" &&
          isSupportedInboxUploadMediaType(part?.mediaType),
      );

      if (fileParts.length > 0 && !scopes.includes("inbox.write")) {
        return c.json({ code: "INSUFFICIENT_SCOPE", error: "Inbox write permission is required to upload files" }, 403);
      }
      for (const [index, part] of fileParts.entries()) {
        try {
          const decoded = decodeDataUrl(new URL(part.url));

          if (!decoded) continue;

          const result = await processInboxUpload({
            db,
            teamId,
            userId: user?.id ?? session.user.id,
            fileData: decoded.data,
            mimeType: part.mediaType || decoded.mediaType,
            fileName: part.filename,
            referenceId: `dashboard_${latestUserMessage.id ?? "latest"}_${index}`,
            platform: "dashboard",
          });

          recentUploadSummaries.push(formatProcessedUploadSummary(result));
        } catch (error) {
          logger.warn("[chat] Failed to process uploaded file", {
            error: error instanceof Error ? error.message : String(error),
            filename: part?.filename,
          });
        }
      }
    }

    const systemPrompt =
      buildSystemPrompt({
        fullName: user?.fullName ?? null,
        locale: user?.locale || geo.locale || "en",
        timezone: resolvedTimezone,
        dateFormat: user?.dateFormat ?? null,
        timeFormat: user?.timeFormat ?? 24,
        baseCurrency: user?.team?.baseCurrency ?? "USD",
        teamName: user?.team?.name ?? null,
        countryCode: user?.team?.countryCode ?? geo.country,
        localTime: clientLocalTime,
        mentionedApps,
        recentUploadSummaries,
      }) + getPlatformInstructions("dashboard");

    const modelMessages = await convertToModelMessages(uiMessages);
    stripFileAndImageParts(modelMessages);

    const rateLimitInfo = c.get("rateLimit");

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (rateLimitInfo) {
          writer.write({
            type: "data-rate-limit",
            id: "rate-limit",
            data: {
              limit: rateLimitInfo.limit,
              remaining: rateLimitInfo.remaining,
            },
          });
        }

        const titlePromise = writeChatTitle(writer, uiMessages);
        const result = await streamMiddayAssistant({
          mcpCtx,
          systemPrompt,
          modelMessages,
          allowExternalTools: c.get("authType") === "session",
        });

        writer.merge(result.toUIMessageStream({ sendSources: true }));
        await titlePromise;
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    logger.error("[chat] Error:", { error: err });

    return c.json(
      { error: "Unable to complete the chat request" },
      500,
    );
  }
});

export const chatRouter = app;
