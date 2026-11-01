import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Socket } from "node:net";
import type { Database } from "@midday/db/client";
import * as durableQueries from "@midday/db/queries/invoice-email-deliveries";
import { Resend } from "resend";
import type { EmailInput } from "./base";
import {
  assertEmailAccepted,
  EmailDeliveryError,
  emptyEmailDeliveryResult,
} from "./services/email-delivery-result";

// Isolated process: the SDK, email templates and notification class are real.
// Only database calls and the HTTP transport are replaced. No live email or
// connection is allowed, and no configured provider credential is used.
const previousFetch = globalThis.fetch;
const previousConnect = Socket.prototype.connect;
const previousResendKey = process.env.RESEND_API_KEY;
const previousEncryptionKey = process.env.MIDDAY_ENCRYPTION_KEY;
let networkAttempts = 0;
const blockNetwork = (): never => {
  networkAttempts += 1;
  throw new Error("Real connections are forbidden in email delivery tests");
};
Socket.prototype.connect = blockNetwork;

const teamId = "957e403d-765f-4c83-b51d-791a8d526341";
const userId = "cdf2ad61-427a-4f31-a908-b524481ad311";
const invoiceId = "3724fae5-0952-455c-b9a2-8ecb5f7e4574";
const fixtureDb = {} as Database;
const events: string[] = [];
const requests: Array<{ url: string; body: unknown }> = [];
const responses: Array<() => Response> = [];
let emailEnabled = true;
let hasTeamMembers = true;
let activityFails = false;

globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!/^https:\/\/api\.resend\.com\/emails(?:\/batch)?$/.test(url)) {
      return blockNetwork();
    }
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    events.push("provider");
    const response = responses.shift();
    if (response) return response();
    const responseBody = Array.isArray(body)
      ? { data: body.map((_, index) => ({ id: `accepted-${index + 1}` })) }
      : { id: `accepted-${requests.length}` };
    return Response.json(responseBody);
  },
  { preconnect: blockNetwork },
);

mock.module("@midday/db/queries", () => ({
  ...durableQueries,
  shouldSendNotification: async (
    _db: unknown,
    _userId: string,
    _teamId: string,
    _type: string,
    channel: string,
  ) => channel !== "email" || emailEnabled,
  getTeamMembers: async () =>
    hasTeamMembers
      ? [
          {
            id: userId,
            role: "owner",
            fullName: "Fixture owner",
            email: "owner@example.test",
            avatarUrl: null,
            locale: "en",
          },
        ]
      : [],
  getTeamById: async () => ({ id: teamId, name: "Fixture", inboxId: teamId }),
  createActivity: async (_db: unknown, input: unknown) => {
    events.push("activity");
    if (activityFails) throw new Error("Fixture activity write failure");
    return input;
  },
  updateActivityMetadata: async () => undefined,
  findRecentActivity: async () => undefined,
}));

let EmailService: typeof import("./services/email-service.js")["EmailService"];
let Notifications: typeof import("./index.js")["Notifications"];
beforeAll(async () => {
  ({ EmailService } = await import("./services/email-service.js"));
  ({ Notifications } = await import("./index.js"));
});
const consoleLog = spyOn(console, "log").mockImplementation(() => {});
const consoleError = spyOn(console, "error").mockImplementation(() => {});

function input(overrides: Partial<EmailInput> = {}): EmailInput {
  return {
    user: { id: userId, email: "owner@example.test", team_id: teamId },
    template: "invoice",
    subject: "Invoice fixture",
    to: ["customer@example.test"],
    data: {
      customerName: "Fixture customer",
      teamName: "Fixture team",
      link: "https://example.test/i/test-token",
    },
    ...overrides,
  };
}

function reject(status: number) {
  responses.push(() =>
    Response.json(
      {
        name: "application_error",
        message: "Fixture rejection",
        statusCode: status,
      },
      { status },
    ),
  );
}

function sendNotification(type: "invoice_sent" | "invoice_reminder_sent") {
  return new Notifications(fixtureDb).create(
    type,
    teamId,
    {
      invoiceId,
      invoiceNumber: "INV-1",
      customerName: "Fixture customer",
      customerEmail: "customer@example.test",
      token: "fixture-token",
    },
    { sendEmail: true, requireEmailAcceptance: true },
  );
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "fixture-resend-key";
  process.env.MIDDAY_ENCRYPTION_KEY = "a".repeat(64);
  requests.length = 0;
  responses.length = 0;
  events.length = 0;
  networkAttempts = 0;
  emailEnabled = true;
  hasTeamMembers = true;
  activityFails = false;
});
afterEach(() => expect(networkAttempts).toBe(0));
afterAll(() => {
  globalThis.fetch = previousFetch;
  Socket.prototype.connect = previousConnect;
  if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousResendKey;
  if (previousEncryptionKey === undefined)
    delete process.env.MIDDAY_ENCRYPTION_KEY;
  else process.env.MIDDAY_ENCRYPTION_KEY = previousEncryptionKey;
  consoleLog.mockRestore();
  consoleError.mockRestore();
});

describe("provider acknowledgement, not inbox delivery", () => {
  test("empty and preference-filtered sends cannot be called accepted", async () => {
    const service = new EmailService(fixtureDb);
    const empty = await service.sendBulk([], "invoice_sent");
    expect(empty).toEqual(emptyEmailDeliveryResult());
    expect(() => assertEmailAccepted(empty)).toThrow(EmailDeliveryError);
    emailEnabled = false;
    const skipped = await service.sendBulk(
      [input({ to: undefined })],
      "invoice_sent",
    );
    expect(skipped).toEqual(emptyEmailDeliveryResult(1));
    expect(requests).toHaveLength(0);
  });

  test("customer preference bypass and BCC remain one accepted envelope", async () => {
    emailEnabled = false;
    const result = await new EmailService(fixtureDb).sendBulk(
      [input({ bcc: ["billing@example.test", "copy@example.test"] })],
      "invoice_sent",
    );
    expect(result).toMatchObject({
      sent: 1,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    });
    expect(result.providerMessageIds).toEqual(["accepted-1"]);
    expect(result.acceptedAt).toBeString();
    expect(() => assertEmailAccepted(result)).not.toThrow();
    expect(requests[0]?.body).toMatchObject([
      {
        to: ["customer@example.test"],
        bcc: ["billing@example.test", "copy@example.test"],
      },
    ]);
  });

  for (const status of [429]) {
    test(`a confirmed HTTP ${status} rejection is retryable and not accepted`, async () => {
      reject(status);
      const service = new EmailService(fixtureDb);
      const result = await service.sendBulk([input()], "invoice_sent");
      expect(result).toMatchObject({
        sent: 0,
        failed: 1,
        uncertain: 0,
        retryable: true,
      });
      const error = new EmailDeliveryError(result);
      expect(error.retryable).toBe(true);
      expect(error.requiresReconciliation).toBe(false);
      // A real subsequent attempt can succeed, without retaining failed counters.
      expect((await service.sendBulk([input()], "invoice_sent")).sent).toBe(1);
    });
  }

  for (const status of [408, 500, 502, 503, 504]) {
    test(`HTTP ${status} may follow acceptance and is not automatically resent`, async () => {
      reject(status);
      const result = await new EmailService(fixtureDb).sendBulk(
        [input()],
        "invoice_sent",
      );
      expect(result).toMatchObject({
        sent: 0,
        failed: 1,
        uncertain: 1,
        retryable: false,
      });
      expect(new EmailDeliveryError(result).requiresReconciliation).toBe(true);
    });
  }

  test("a permanent provider validation rejection does not ask for retries", async () => {
    reject(422);
    const result = await new EmailService(fixtureDb).sendBulk(
      [input()],
      "invoice_sent",
    );
    expect(result).toMatchObject({
      sent: 0,
      failed: 1,
      uncertain: 0,
      retryable: false,
    });
    expect(result.acceptedAt).toBeUndefined();
  });

  test("SDK-resolved network failure is ambiguous, not a safe rejection", async () => {
    responses.push(() => {
      throw new Error("Fixture transport interruption");
    });
    const result = await new EmailService(fixtureDb).sendBulk(
      [input()],
      "invoice_sent",
    );
    expect(result).toMatchObject({
      sent: 0,
      failed: 1,
      uncertain: 1,
      retryable: false,
    });
    expect(new EmailDeliveryError(result).requiresReconciliation).toBe(true);
  });

  test("an exception thrown by the provider client is also ambiguous", async () => {
    const client = new Resend("fixture-only-key");
    client.batch.send = async () => {
      throw new Error("Fixture SDK throw");
    };
    const result = await new EmailService(fixtureDb, client).sendBulk(
      [input()],
      "invoice_sent",
    );
    expect(result).toMatchObject({
      sent: 0,
      failed: 1,
      uncertain: 1,
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });

  for (const data of [null, {}, { data: [] }, { data: [{ id: "" }] }]) {
    test(`missing provider IDs are not counted as accepted: ${JSON.stringify(data)}`, async () => {
      responses.push(() => Response.json(data));
      const result = await new EmailService(fixtureDb).sendBulk(
        [input()],
        "invoice_sent",
      );
      expect(result).toMatchObject({
        sent: 0,
        failed: 1,
        uncertain: 1,
        retryable: false,
      });
    });
  }

  test("batch counts are based on distinct acknowledgements, not input length", async () => {
    responses.push(() =>
      Response.json({ data: [{ id: "one" }, { id: "one" }] }),
    );
    const result = await new EmailService(fixtureDb).sendBulk(
      [input(), input()],
      "invoice_sent",
    );
    expect(result).toMatchObject({
      sent: 1,
      failed: 1,
      uncertain: 1,
      retryable: false,
    });
    expect(new EmailDeliveryError(result).requiresReconciliation).toBe(true);
  });

  test("attachments preserve partial acceptance across independent sends", async () => {
    responses.push(() => Response.json({ id: "first-accepted" }));
    reject(429);
    const result = await new EmailService(fixtureDb).sendBulk(
      [
        input({
          attachments: [{ filename: "fixture.pdf", content: "fixture" }],
        }),
        input(),
      ],
      "invoice_sent",
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.resend.com/emails",
      "https://api.resend.com/emails",
    ]);
    expect(result).toMatchObject({
      sent: 1,
      failed: 1,
      uncertain: 0,
      retryable: false,
    });
    expect(result.providerMessageIds).toEqual(["first-accepted"]);
  });

  test("render/configuration failures happen before all external calls", async () => {
    const result = await new EmailService(fixtureDb).sendBulk(
      [input(), input({ template: "not-a-template" })],
      "invoice_sent",
    );
    expect(result).toMatchObject({
      sent: 0,
      failed: 2,
      uncertain: 0,
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });
});

describe("honest sent activities", () => {
  for (const type of ["invoice_sent", "invoice_reminder_sent"] as const) {
    test(`${type} is created only after provider acceptance`, async () => {
      const result = await sendNotification(type);
      expect(result.activities).toBe(1);
      expect(result.emails.sent).toBe(1);
      expect(events).toEqual(["provider", "activity"]);
      expect(JSON.stringify(requests[0]?.body)).not.toContain(
        "requireEmailAcceptance",
      );
    });

    test(`${type} rejection creates no false sent activity`, async () => {
      reject(429);
      await expect(sendNotification(type)).rejects.toBeInstanceOf(
        EmailDeliveryError,
      );
      expect(events).toEqual(["provider"]);
    });
  }

  test("zero team members cannot turn a no-op into a sent invoice", async () => {
    hasTeamMembers = false;
    await expect(sendNotification("invoice_sent")).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
    expect(events).toEqual([]);
  });

  test("post-acceptance activity error retains the known acceptance", async () => {
    activityFails = true;
    try {
      await sendNotification("invoice_sent");
      throw new Error("Expected activity failure");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      if (!(error instanceof EmailDeliveryError)) throw error;
      expect(error.phase).toBe("activity");
      expect(error.result.sent).toBe(1);
      expect(error.result.providerMessageIds).toEqual(["accepted-1"]);
      expect(error.requiresReconciliation).toBe(true);
      expect(error.retryable).toBe(false);
    }
    expect(events).toEqual(["provider", "activity"]);
  });

  test("ordinary in-app notifications are unchanged without strict mode", async () => {
    const result = await new Notifications(fixtureDb).create(
      "transactions_created",
      teamId,
      { transactions: [] },
    );
    expect(result.activities).toBe(1);
    expect(result.emails.sent).toBe(0);
    expect(events).toEqual(["activity"]);
  });
});
