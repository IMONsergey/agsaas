import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import type { Database } from "@midday/db/client";

const teamId = "00000000-0000-4000-8000-000000000001";
const recurringId = "00000000-0000-4000-8000-000000000002";
const scheduled = "2099-01-01T10:00:00.000Z";
const payload = { teamId, recurringId, nextScheduledAt: scheduled };
const savedConnect = Socket.prototype.connect;
const savedFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(
  [
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "EMAIL_REPLY_TO",
    "TEAM_INVITATION_FROM",
    "DASHBOARD_URL",
    "APP_NAME",
  ].map((key) => [key, process.env[key]]),
);
const forbidden = (): never => {
  throw new Error("Network forbidden in upcoming notification tests");
};
Socket.prototype.connect = forbidden;
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
const db = { usePrimaryOnly: () => db } as unknown as Database;
let series: any;
let failMarker = false;
let sends = 0;
const markers: any[] = [];
const identities: string[] = [];
const rows = new Map<string, any>();
const rowKey = (scope: any) => `${scope.teamId}:${scope.operationKey}`;
const activityKeys = new Set<string>();
mock.module("@midday/db/queries", () => ({
  getInvoiceRecurringById: async (
    actualDb: unknown,
    scope: { id: string; teamId: string },
  ) => {
    expect(actualDb).toBe(db);
    return scope.id === recurringId && scope.teamId === teamId ? series : null;
  },
  markUpcomingNotificationSent: async (_db: unknown, scope: unknown) => {
    markers.push(scope);
    if (failMarker) throw new Error("Fixture marker DB failure");
    return {};
  },
}));
mock.module("@midday/notifications", () => ({
  Notifications: class {
    async create(
      _type: string,
      _teamId: string,
      _data: unknown,
      options: {
        sendEmail: boolean;
        skipActivities?: boolean;
        activityOperationKey?: string;
      },
    ) {
      if (options.sendEmail) {
        sends++;
        expect(options.skipActivities).toBe(true);
      } else {
        expect(options.activityOperationKey).toBeDefined();
        activityKeys.add(options.activityOperationKey!);
      }
      return {
        type: "recurring_invoice_upcoming",
        activities: options.sendEmail ? 0 : 1,
        emails: {
          sent: options.sendEmail ? 1 : 0,
          skipped: 0,
          failed: 0,
          uncertain: 0,
          retryable: false,
          providerMessageIds: options.sendEmail ? ["fixture-accepted"] : [],
        },
      };
    }
  },
}));
mock.module("@midday/db/queries/notification-dispatches", () => ({
  notificationDispatchOperationKey: (kind: string, id: string) =>
    createHash("sha256").update(`${kind}:${id}`).digest("hex"),
  ensureNotificationDispatch: async (_db: unknown, input: any) => {
    identities.push(input.sourceJobId);
    let row = rows.get(rowKey(input));
    if (!row) {
      row = { ...input, id: "fixture", status: "pending" };
      rows.set(rowKey(input), row);
    }
    return row;
  },
  beginNotificationDispatch: async (
    _db: unknown,
    scope: any,
    ready: boolean,
  ) => {
    const row = rows.get(rowKey(scope));
    if (!ready) return { state: "pending", row };
    row.status = "dispatching";
    return { state: "claimed", row, token: "fixture-fence" };
  },
  finishNotificationDispatch: async (
    _db: unknown,
    scope: any,
    outcome: any,
  ) => {
    const row = rows.get(rowKey(scope));
    row.status = "completed";
    row.outcome = outcome;
    return row;
  },
  interruptNotificationDispatch: async () => {
    throw new Error("Unexpected interrupted fixture");
  },
  stopPendingNotificationDispatch: async (_db: unknown, scope: any) => {
    const row = rows.get(rowKey(scope));
    row.status = "rejected";
    return row;
  },
}));
const { deliverUpcomingNotification } = await import(
  "./upcoming-notification-delivery"
);
beforeEach(() => {
  rows.clear();
  identities.length = 0;
  markers.length = 0;
  activityKeys.clear();
  sends = 0;
  failMarker = false;
  series = {
    id: recurringId,
    teamId,
    status: "active",
    nextScheduledAt: scheduled,
    frequency: "monthly_date",
    customerName: "Fixture",
    amount: 100,
    currency: "USD",
  };
  process.env.RESEND_API_KEY = "re_fixture_only";
  process.env.EMAIL_FROM = "AGSaaS <accounts@example.test>";
  process.env.DASHBOARD_URL = "https://app.example.test";
  delete process.env.EMAIL_REPLY_TO;
  delete process.env.TEAM_INVITATION_FROM;
});
afterAll(() => {
  Socket.prototype.connect = savedConnect;
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("upcoming recurring notification dispatch", () => {
  test("missing email key preserves in-app visibility but never marks the cycle notified", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(deliverUpcomingNotification(db, payload)).rejects.toThrow(
      "deferred",
    );
    await expect(deliverUpcomingNotification(db, payload)).rejects.toThrow(
      "deferred",
    );
    expect(sends).toBe(0);
    expect(markers).toHaveLength(0);
    expect(activityKeys.size).toBe(1);
    process.env.RESEND_API_KEY = "re_fixture_only";
    expect(await deliverUpcomingNotification(db, payload)).toMatchObject({
      accepted: 1,
      reused: false,
    });
    expect(markers).toEqual([
      { id: recurringId, teamId, expectedNextScheduledAt: scheduled },
    ]);
  });
  test("marker failure reuses the same accepted occurrence, regardless of scheduler run", async () => {
    failMarker = true;
    await expect(deliverUpcomingNotification(db, payload)).rejects.toThrow(
      "marker DB failure",
    );
    failMarker = false;
    expect(
      await deliverUpcomingNotification(db, {
        ...payload,
        nextScheduledAt: "2099-01-01T11:00:00+01:00",
      }),
    ).toMatchObject({ accepted: 1, reused: true });
    expect(sends).toBe(1);
    expect(new Set(identities).size).toBe(1);
    expect(markers).toHaveLength(2);
  });
  test("rescheduled, paused and expired cycles cannot be sent or marked", async () => {
    for (const change of [
      { nextScheduledAt: "2099-02-01T10:00:00.000Z" },
      { status: "paused" },
      { nextScheduledAt: "2000-01-01T10:00:00.000Z" },
    ]) {
      rows.clear();
      series = {
        ...series,
        status: "active",
        nextScheduledAt: scheduled,
        ...change,
      };
      await expect(
        deliverUpcomingNotification(db, {
          ...payload,
          ...(change.nextScheduledAt?.startsWith("2000")
            ? { nextScheduledAt: change.nextScheduledAt }
            : {}),
        }),
      ).rejects.toThrow("event_expired");
    }
    expect(sends).toBe(0);
    expect(markers).toHaveLength(0);
  });
  test("a new occurrence receives its own intent and foreign scope is rejected", async () => {
    await deliverUpcomingNotification(db, payload);
    const next = "2099-02-01T10:00:00.000Z";
    series.nextScheduledAt = next;
    await deliverUpcomingNotification(db, {
      ...payload,
      nextScheduledAt: next,
    });
    expect(sends).toBe(2);
    expect(new Set(identities).size).toBe(2);
    await expect(
      deliverUpcomingNotification(db, {
        ...payload,
        teamId: "00000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow("event_expired");
    expect(sends).toBe(2);
  });
});
