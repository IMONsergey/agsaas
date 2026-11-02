import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { resolveRedisUrl } from "@midday/cache/shared-redis";
import { Chat } from "chat";
import { createSendblueAdapter } from "chat-adapter-sendblue";

function hasCredentials(...names: string[]) {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

export function createMiddayBot() {
  return new Chat({
    userName: "midday",
    adapters: {
      // These are the SDKs' required credential groups. An absent or partial
      // integration must not prevent unrelated API routes from starting.
      ...(hasCredentials(
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_APP_SECRET",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_VERIFY_TOKEN",
      ) && { whatsapp: createWhatsAppAdapter() }),
      ...(hasCredentials("TELEGRAM_BOT_TOKEN") && {
        telegram: createTelegramAdapter(),
      }),
      ...(hasCredentials("SLACK_SIGNING_SECRET") && {
        slack: createSlackAdapter(),
      }),
      ...(hasCredentials(
        "SENDBLUE_API_KEY",
        "SENDBLUE_API_SECRET",
        "SENDBLUE_FROM_NUMBER",
      ) && { sendblue: createSendblueAdapter() }),
    },
    state: createRedisState({ url: resolveRedisUrl() }),
    concurrency: {
      strategy: "debounce",
      debounceMs: 1500,
    },
  });
}

export const bot = createMiddayBot();
