import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const groups = {
  whatsapp: [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_VERIFY_TOKEN",
  ],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  slack: ["SLACK_SIGNING_SECRET"],
  sendblue: ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER"],
} as const;
type Platform = keyof typeof groups;
const platforms = Object.keys(groups) as Platform[];
const keys = [...Object.values(groups).flat(), "REDIS_URL"];
const previousEnvironment = new Map(keys.map((key) => [key, process.env[key]]));

for (const key of keys) delete process.env[key];
process.env.REDIS_URL = "redis://localhost:6379";

const state = {
  connect: mock(async () => undefined),
  disconnect: mock(async () => undefined),
};
const createState = mock(() => state);
mock.module("@chat-adapter/state-redis", () => ({
  createRedisState: createState,
}));

function adapter(name: Platform) {
  return {
    name,
    initialize: mock(async () => undefined),
    disconnect: mock(async () => undefined),
  };
}
const adapters = {
  whatsapp: adapter("whatsapp"),
  telegram: adapter("telegram"),
  slack: adapter("slack"),
  sendblue: adapter("sendblue"),
};
const factories = {
  whatsapp: mock(() => adapters.whatsapp),
  telegram: mock(() => adapters.telegram),
  slack: mock(() => adapters.slack),
  sendblue: mock(() => adapters.sendblue),
};
mock.module("@chat-adapter/whatsapp", () => ({
  createWhatsAppAdapter: factories.whatsapp,
}));
mock.module("@chat-adapter/telegram", () => ({
  createTelegramAdapter: factories.telegram,
}));
mock.module("@chat-adapter/slack", () => ({
  createSlackAdapter: factories.slack,
}));
mock.module("chat-adapter-sendblue", () => ({
  createSendblueAdapter: factories.sendblue,
}));

const { bot, createMiddayBot } = await import(
  "../../../../../packages/bot/src/instance"
);

beforeEach(() => {
  for (const names of Object.values(groups)) {
    for (const name of names) delete process.env[name];
  }
  for (const platform of platforms) {
    factories[platform].mockClear();
    adapters[platform].initialize.mockClear();
    adapters[platform].disconnect.mockClear();
  }
  state.connect.mockClear();
  state.disconnect.mockClear();
});

afterAll(() => {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("optional bot adapters", () => {
  test("the imported singleton starts with no adapters and no Redis connection", () => {
    expect(Object.keys(bot.webhooks)).toEqual([]);
    expect(bot.getAdapter("slack")).toBeUndefined();
    expect(createState).toHaveBeenCalledTimes(1);
    expect(state.connect).not.toHaveBeenCalled();
    for (const create of Object.values(factories))
      expect(create).not.toHaveBeenCalled();
  });

  test.each(
    platforms,
  )("enables only a fully configured %s", async (platform) => {
    for (const name of groups[platform])
      process.env[name] = "local-test-credential";
    const instance = createMiddayBot();

    expect(Object.keys(instance.webhooks)).toEqual([platform]);
    expect(Object.is(instance.getAdapter(platform), adapters[platform])).toBe(
      true,
    );
    expect(state.connect).not.toHaveBeenCalled();
    await instance.initialize();
    await instance.shutdown();

    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.disconnect).toHaveBeenCalledTimes(1);
    for (const candidate of platforms) {
      expect(factories[candidate]).toHaveBeenCalledTimes(
        candidate === platform ? 1 : 0,
      );
      expect(adapters[candidate].initialize).toHaveBeenCalledTimes(
        candidate === platform ? 1 : 0,
      );
    }
  });

  test.each(
    platforms,
  )("does not create partially configured %s", (platform) => {
    for (const name of groups[platform])
      process.env[name] = "local-test-credential";
    for (const missing of groups[platform]) {
      delete process.env[missing];
      expect(Object.keys(createMiddayBot().webhooks)).toEqual([]);
      expect(factories[platform]).not.toHaveBeenCalled();
      process.env[missing] = "local-test-credential";
    }
  });

  test("whitespace-only credentials do not enable an adapter", () => {
    process.env.TELEGRAM_BOT_TOKEN = "  ";
    expect(Object.keys(createMiddayBot().webhooks)).toEqual([]);
    expect(factories.telegram).not.toHaveBeenCalled();
  });

  test("retains all four adapters when all required groups are present", async () => {
    for (const names of Object.values(groups)) {
      for (const name of names) process.env[name] = "local-test-credential";
    }
    const instance = createMiddayBot();
    expect(Object.keys(instance.webhooks)).toEqual(platforms);
    await instance.initialize();
    await instance.shutdown();
    for (const platform of platforms) {
      expect(adapters[platform].initialize).toHaveBeenCalledTimes(1);
      expect(adapters[platform].disconnect).toHaveBeenCalledTimes(1);
    }
  });
});
