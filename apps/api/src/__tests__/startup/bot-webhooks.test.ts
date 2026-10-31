import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const calls: string[] = [];
const initialize = mock(async () => {
  calls.push("initialize");
});
const handleWebhook = mock(async (_request: Request) => {
  calls.push("webhook");
  return new Response("provider response", { status: 202 });
});
type Platform = "whatsapp" | "telegram" | "sendblue" | "slack";
const webhooks: Partial<Record<Platform, typeof handleWebhook>> = {};

mock.module("@midday/bot", () => ({ bot: { initialize, webhooks } }));
mock.module("@api/bot/runtime", () => ({
  registerMiddayBotRuntime: () => undefined,
}));

const { whatsappWebhookRouter } = await import(
  "../../rest/routers/webhooks/whatsapp"
);
const { telegramWebhookRouter } = await import(
  "../../rest/routers/webhooks/telegram"
);
const { sendblueWebhookRouter } = await import(
  "../../rest/routers/webhooks/sendblue"
);
const { webhookRouter: slackWebhookRouter } = await import(
  "../../rest/routers/apps/slack/webhook"
);

const app = new Hono();
app.route("/whatsapp", whatsappWebhookRouter);
app.route("/telegram", telegramWebhookRouter);
app.route("/sendblue", sendblueWebhookRouter);
app.route("/slack", slackWebhookRouter);

beforeEach(() => {
  for (const name of Object.keys(webhooks) as Platform[]) delete webhooks[name];
  calls.length = 0;
  initialize.mockClear();
  handleWebhook.mockClear();
});

const routes = [
  ["whatsapp", "GET"],
  ["whatsapp", "POST"],
  ["telegram", "POST"],
  ["sendblue", "POST"],
  ["slack", "POST"],
] as const;

describe("optional platform webhooks", () => {
  test.each(
    routes,
  )("disabled %s %s returns 503 before initialization", async (platform, method) => {
    const response = await app.request(`/${platform}`, { method });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: `${platform === "whatsapp" ? "WhatsApp" : platform[0]?.toUpperCase() + platform.slice(1)} is not configured`,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test.each(
    routes,
  )("configured %s %s preserves its request and provider response", async (platform, method) => {
    webhooks[platform] = handleWebhook;
    const request = new Request(`http://localhost/${platform}`, { method });
    const response = await app.fetch(request);

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("provider response");
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(handleWebhook).toHaveBeenCalledWith(request);
    expect(calls).toEqual(["initialize", "webhook"]);
  });
});
