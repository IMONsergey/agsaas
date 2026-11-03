import { afterEach, beforeEach, expect, mock, test } from "bun:test";
const messages: unknown[] = [];
const views: unknown[] = [];
const fakeClient = {
  chat: {
    postMessage: async (message: unknown) => {
      messages.push(message);
      return { ok: true };
    },
  },
  views: {
    publish: async (view: unknown) => {
      views.push(view);
      return { ok: true };
    },
  },
  conversations: {
    info: async () => ({ channel: { name: "fixture-channel" } }),
  },
};
mock.module("@midday/logger", () => ({
  logger: { debug() {}, error() {} },
  createLoggerWithContext: () => ({ debug() {}, error() {} }),
}));
mock.module("@midday/db/queries", () => ({
  getTeamById: async () => ({ id: "fixture-team" }),
  getAppByAppId: async () => ({
    config: { access_token: "fixture-slack-token" },
  }),
}));
mock.module("@midday/db/worker-client", () => ({ getWorkerDb: () => ({}) }));
mock.module("./client", () => ({
  createSlackWebClient: () => fakeClient,
  ensureBotInChannel: async () => {},
}));
const { publishAppHome } = await import("./app-home");
const { sendSlackMatchNotification } = await import("./notifications/match");
const { sendSlackTransactionNotifications } = await import(
  "./notifications/transactions"
);
const keys = [
  "NODE_ENV",
  "DASHBOARD_URL",
  "NEXT_PUBLIC_URL",
  "MIDDAY_DASHBOARD_URL",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;
beforeEach(() => {
  messages.length = 0;
  views.length = 0;
  process.env.NODE_ENV = "production";
  process.env.DASHBOARD_URL = "https://dashboard.owned.example:8543";
  globalThis.fetch = (() => {
    throw new Error("Provider network access is forbidden in this fixture");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function urls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(urls);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      key === "url" && typeof child === "string" ? [child] : urls(child),
    );
  }
  return [];
}
test("Slack home buttons all stay on the configured dashboard", async () => {
  await publishAppHome({
    client: fakeClient as never,
    userId: "fixture-slack-user",
    db: {} as never,
    teamId: "fixture-team",
    slackApp: { config: {} },
  });
  expect(views).toHaveLength(1);
  expect(urls(views)).toEqual([
    "https://dashboard.owned.example:8543/apps?app=slack&settings=true",
    "https://dashboard.owned.example:8543",
    "https://dashboard.owned.example:8543/apps?app=slack&settings=true",
  ]);
});
test("Slack match notifications preserve escaped document and transaction identifiers", async () => {
  const base = {
    teamId: "fixture-team",
    inboxId: "inbox&next=1",
    transactionId: "tx&next=2",
    documentName: "Fixture receipt",
    documentAmount: 1,
    documentCurrency: "USD",
    transactionName: "Fixture transaction",
    transactionAmount: 1,
    transactionCurrency: "USD",
    slackChannelId: "fixture-channel",
  };
  await sendSlackMatchNotification({ ...base, matchType: "auto_matched" });
  await sendSlackMatchNotification({ ...base, matchType: "suggested" });
  expect(urls(messages)).toEqual([
    "https://dashboard.owned.example:8543/transactions?id=tx%26next%3D2",
    "https://dashboard.owned.example:8543/inbox?inboxId=inbox%26next%3D1",
  ]);
});
test("transaction notifications contain neither the upstream Slack application nor its dashboard", async () => {
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    async single() {
      return {
        data: {
          settings: [{ id: "transactions", value: true }],
          config: {
            access_token: "fixture-token",
            channel_id: "fixture-channel",
          },
        },
      };
    },
  };
  await sendSlackTransactionNotifications({
    teamId: "fixture-team",
    transactions: [{ amount: "$1", name: "Fixture transaction" }],
    supabase: { from: () => query } as never,
  });
  expect(messages).toHaveLength(1);
  expect(urls(messages)).toEqual([
    "https://dashboard.owned.example:8543/transactions",
  ]);
  expect(JSON.stringify(messages)).not.toContain("A07PN48FW3A");
  expect(JSON.stringify(messages)).not.toContain("midday.ai");
});
