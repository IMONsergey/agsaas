import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import { type Job, UnrecoverableError } from "bullmq";

const savedFetch = globalThis.fetch,
  savedConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error("Live network forbidden in invitation worker tests");
};
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
Socket.prototype.connect = forbidden;
const scope = {
  teamId: "5c3ba77e-2df0-4208-a8c5-bbde45f163b0",
  inviteId: "08ea8849-f5c0-4b50-8277-e450c93db528",
  deliveryId: "672ee6a8-9985-4d08-80ee-7a80807fc834",
};
const scopes = [
  scope,
  { ...scope, deliveryId: "5b7fbc1a-033e-4eca-a6d3-1c3d769d8684" },
];
let status = "accepted",
  errorOnce = false;
const received: unknown[] = [],
  warnings: unknown[] = [];
mock.module("@midday/db/worker-client", () => ({ getWorkerDb: () => ({}) }));
mock.module("@midday/db/queries", () => ({
  listRecoverableTeamInviteDeliveries: async () => scopes,
}));
mock.module("@midday/notifications/team-invitation-delivery", () => ({
  deliverTeamInvitation: async (_db: unknown, s: unknown) => {
    received.push(s);
    if (errorOnce) {
      errorOnce = false;
      throw new Error("private@example.test rendered HTML and SQL parameters");
    }
    return { status };
  },
  TeamInvitationDeliveryPendingError: class extends Error {},
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info() {},
    debug() {},
    error() {},
    warn(...args: unknown[]) {
      warnings.push(args);
    },
  }),
}));
mock.module("@sentry/bun", () => ({ captureException() {} }));
const { DeliverTeamInvitationProcessor } = await import(
  "./deliver-team-invitation"
);
const { ReconcileTeamInvitationsProcessor } = await import(
  "./reconcile-team-invitations"
);
beforeEach(() => {
  status = "accepted";
  errorOnce = false;
  received.length = 0;
  warnings.length = 0;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  Socket.prototype.connect = savedConnect;
});
describe("invitation worker contract", () => {
  test("passes only durable scoped IDs and reports accepted", async () => {
    expect(
      await new DeliverTeamInvitationProcessor().process({ data: scope } as Job<
        typeof scope
      >),
    ).toEqual({ status: "accepted" });
    expect(received).toEqual([scope]);
  });
  test("pending delivery is retried, permanent reconciliation does not auto-send", async () => {
    const processor = new DeliverTeamInvitationProcessor();
    status = "pending";
    await expect(
      processor.process({ data: scope } as Job<typeof scope>),
    ).rejects.toThrow();
    status = "reconciliation";
    await expect(
      processor.process({ data: scope } as Job<typeof scope>),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
  test("one poisoned recovery row does not starve another or leak provider data", async () => {
    errorOnce = true;
    const result = await new ReconcileTeamInvitationsProcessor().process(
      {} as Job<Record<string, never>>,
    );
    expect(result).toEqual({
      scanned: 2,
      accepted: 1,
      deferred: 1,
      stopped: 0,
    });
    expect(received).toEqual(scopes);
    expect(JSON.stringify(warnings)).not.toContain("private@example.test");
    expect(JSON.stringify(warnings)).not.toContain("HTML");
  });
});
