import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import type { Database } from "@midday/db/client";
import type { NotificationDispatchOutcome } from "@midday/db/notification-dispatch";

// This process substitutes SQL only. The real provider SDK produces acceptance,
// rejection and partial results; PostgreSQL tests verify actual SQL transitions.
const savedFetch = globalThis.fetch;
const savedConnect = Socket.prototype.connect;
const keys = [
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "TEAM_INVITATION_FROM",
  "DASHBOARD_URL",
  "APP_NAME",
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const requests: unknown[] = [];
const responses: Array<() => Response> = [];
const readyChecks: boolean[] = [];
const outcomes: NotificationDispatchOutcome[] = [];
const activityKeys = new Set<string>();
let row: any = null;
let finishStatus = "completed";
let failReceipt = false;
let interrupted = 0;
const forbidden = (): never => {
  throw new Error("Live network forbidden in dispatch tests");
};
Socket.prototype.connect = forbidden;
globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (
      !/^https:\/\/api\.resend\.com\/emails(?:\/batch)?$/.test(String(input)) ||
      typeof init?.body !== "string"
    )
      return forbidden();
    const body = JSON.parse(init.body);
    requests.push(body);
    const response = responses.shift();
    return response
      ? response()
      : Response.json(
          Array.isArray(body)
            ? {
                data: body.map((_: unknown, index: number) => ({
                  id: `accepted-${requests.length}-${index}`,
                })),
              }
            : { id: `accepted-${requests.length}` },
        );
  },
  { preconnect: forbidden },
);
mock.module("@midday/db/queries", () => ({
  shouldSendNotification: async () => true,
}));
mock.module("@midday/db/queries/notification-dispatches", () => ({
  notificationDispatchOperationKey: (kind: string, id: string) =>
    createHash("sha256").update(`${kind}:${id}`).digest("hex"),
  ensureNotificationDispatch: async (_db: unknown, input: unknown) =>
    (row ??= {
      ...(input as object),
      id: "fixture-dispatch",
      status: "pending",
      attempts: 0,
    }),
  beginNotificationDispatch: async (
    _db: unknown,
    _scope: unknown,
    ready: boolean,
  ) => {
    readyChecks.push(ready);
    if (row.status === "dispatching") return { state: "busy", row };
    if (!ready) return { state: "pending", row };
    row.status = "dispatching";
    row.attempts++;
    return { state: "claimed", token: "fixture-token", row };
  },
  finishNotificationDispatch: async (
    _db: unknown,
    _scope: unknown,
    outcome: NotificationDispatchOutcome,
  ) => {
    outcomes.push(outcome);
    if (failReceipt) throw new Error("private database connection details");
    row.outcome = outcome;
    row.status = finishStatus;
    return row;
  },
  interruptNotificationDispatch: async () => {
    interrupted++;
    row.status = "reconciliation";
  },
  stopPendingNotificationDispatch: async () => {
    row.status = "rejected";
    row.lastError = "event_expired";
    return row;
  },
}));
const { EmailService } = await import("@midday/notifications/email-service");
const { dispatchNotificationEmail, NotificationDispatchPendingError } =
  await import("./notification-dispatch");
const { NonRetryableError } = await import("./error-classification");
const db = {} as Database;
const payload = {
  teamId: "00000000-0000-4000-8000-000000000001",
  type: "fixture",
};
const emails = [1, 2].map((number) => ({
  user: {
    id: "fixture",
    team_id: payload.teamId,
    email: `person${number}@example.test`,
  },
  to: `person${number}@example.test`,
  template: "payment-issue",
  subject: "Fixture notice",
  data: { fullName: "Fixture", teamName: "Fixture team" },
  attachments: [{ filename: "fixture.txt", content: "ZmFrZQ==" }],
}));
const send = async () => ({
  type: "fixture",
  activities: 0,
  emails: await new EmailService(db).sendBulk(emails, "fixture"),
});
function dispatch(overrideSend = send) {
  return dispatchNotificationEmail({
    db,
    kind: "notification",
    sourceJobId: "fixture-job",
    payload,
    send: overrideSend,
    createActivities: async (key) => {
      const inserted = activityKeys.has(key) ? 0 : 1;
      activityKeys.add(key);
      return inserted;
    },
  });
}
beforeEach(() => {
  row = null;
  finishStatus = "completed";
  failReceipt = false;
  interrupted = 0;
  requests.length = 0;
  responses.length = 0;
  outcomes.length = 0;
  readyChecks.length = 0;
  activityKeys.clear();
  process.env.RESEND_API_KEY = "re_fixture_only";
  process.env.EMAIL_FROM = "AGSaaS <accounts@example.test>";
  process.env.DASHBOARD_URL = "https://app.example.test";
  process.env.APP_NAME = "AGSaaS";
  delete process.env.TEAM_INVITATION_FROM;
  delete process.env.EMAIL_REPLY_TO;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  Socket.prototype.connect = savedConnect;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("generic email dispatch orchestration", () => {
  test("unavailable provider or identity keeps in-app event and defers before HTTP/claim", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(dispatch()).rejects.toBeInstanceOf(
      NotificationDispatchPendingError,
    );
    process.env.RESEND_API_KEY = "re_fixture_only";
    delete process.env.EMAIL_FROM;
    await expect(dispatch()).rejects.toBeInstanceOf(
      NotificationDispatchPendingError,
    );
    expect(readyChecks).toEqual([false, false]);
    expect(row.attempts).toBe(0);
    expect(activityKeys.size).toBe(1);
    expect(requests).toHaveLength(0);
    process.env.EMAIL_FROM = "AGSaaS <accounts@example.test>";
    expect(await dispatch()).toMatchObject({
      status: "completed",
      accepted: 2,
    });
  });
  test("accepted result is reused and recipient envelopes are not dispatched twice", async () => {
    expect(await dispatch()).toMatchObject({ accepted: 2, reused: false });
    expect(await dispatch()).toMatchObject({ accepted: 2, reused: true });
    expect(requests).toHaveLength(2);
    expect(row.attempts).toBe(1);
    expect(activityKeys.size).toBe(1);
  });
  test("resolved 400 rejection fails honestly and no unsafe retry runs", async () => {
    finishStatus = "rejected";
    for (let i = 0; i < 2; i++)
      responses.push(() =>
        Response.json(
          {
            name: "validation_error",
            message: "private-recipient",
            statusCode: 400,
          },
          { status: 400 },
        ),
      );
    await expect(dispatch()).rejects.toBeInstanceOf(NonRetryableError);
    expect(outcomes[0]).toMatchObject({
      sent: 0,
      failed: 2,
      uncertain: 0,
      retryable: false,
    });
    await expect(dispatch()).rejects.toThrow("rejected");
    expect(requests).toHaveLength(2);
  });
  test("partial recipient acceptance followed by 429 stops for reconciliation", async () => {
    finishStatus = "reconciliation";
    responses.push(() => Response.json({ id: "accepted-first" }));
    responses.push(() =>
      Response.json(
        { name: "rate_limit_exceeded", message: "fixture", statusCode: 429 },
        { status: 429 },
      ),
    );
    await expect(dispatch()).rejects.toThrow("reconciliation");
    expect(outcomes[0]).toMatchObject({
      sent: 1,
      failed: 1,
      uncertain: 0,
      retryable: false,
      providerMessageIds: ["accepted-first"],
    });
    await expect(dispatch()).rejects.toBeInstanceOf(NonRetryableError);
    expect(requests).toHaveLength(2);
  });
  test("all-rejected rate limits remain pending and can recover safely", async () => {
    finishStatus = "pending";
    for (let i = 0; i < 2; i++)
      responses.push(() =>
        Response.json(
          { name: "rate_limit_exceeded", message: "fixture", statusCode: 429 },
          { status: 429 },
        ),
      );
    await expect(dispatch()).rejects.toBeInstanceOf(
      NotificationDispatchPendingError,
    );
    expect(outcomes[0]).toMatchObject({
      sent: 0,
      failed: 2,
      uncertain: 0,
      retryable: true,
    });
    finishStatus = "completed";
    expect(await dispatch()).toMatchObject({ accepted: 2, reused: false });
    expect(activityKeys.size).toBe(1);
  });
  test("lost acknowledgements and thrown dispatch never become successful completion", async () => {
    finishStatus = "reconciliation";
    for (let i = 0; i < 2; i++)
      responses.push(() => {
        throw new Error("accepted then lost response");
      });
    await expect(dispatch()).rejects.toThrow("reconciliation");
    expect(outcomes[0]).toMatchObject({
      sent: 0,
      failed: 2,
      uncertain: 2,
      retryable: false,
    });
    await expect(dispatch()).rejects.toBeInstanceOf(NonRetryableError);
    expect(requests).toHaveLength(2);
    row = null;
    await expect(
      dispatch(async () => {
        throw new Error("raw provider details");
      }),
    ).rejects.toThrow("reconciliation");
    expect(interrupted).toBe(1);
  });
  test("receipt write failure retains the dispatch fence and prevents a resend", async () => {
    failReceipt = true;
    await expect(dispatch()).rejects.toThrow("receipt_reconciliation");
    expect(row.status).toBe("dispatching");
    await expect(dispatch()).rejects.toBeInstanceOf(
      NotificationDispatchPendingError,
    );
    expect(requests).toHaveLength(2);
    expect(outcomes).toHaveLength(1);
  });
});
