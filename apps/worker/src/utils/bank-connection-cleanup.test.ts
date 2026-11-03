import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { hostedPlaidClientBinding } from "@midday/db/bank-consent";
import { Socket } from "node:net";
import type {
  BankCleanupOutcome,
  BankCleanupTarget,
} from "@midday/db/bank-connection-cleanup";
import type { Database } from "@midday/db/client";
import type { Job } from "bullmq";

const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
const forbidden = (): never => {
  throw new Error(
    "Real providers, Redis and SQL are forbidden in cleanup unit tests",
  );
};
globalThis.fetch = Object.assign(async () => forbidden(), {
  preconnect: forbidden,
});
Socket.prototype.connect = forbidden;
afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
});
const target: BankCleanupTarget = {
  provider: "plaid",
  referenceId: "fixture-item",
  accessToken: "secret-never-in-a-job",
};
let row: {
  id: string;
  status: "pending" | "processing" | "completed" | "reconciliation";
  encryptedPayload: string | null;
  attempts: number;
  startedAt: string | null;
};
let canOpen = true;
let consentBinding: {
  environment: "sandbox" | "production";
  clientFingerprint: string;
} | null = null;
let bindingFailure = false;
const previousPlaidEnvironment = process.env.PLAID_ENVIRONMENT;
const previousPlaidClient = process.env.PLAID_CLIENT_ID;
afterAll(() => {
  if (previousPlaidEnvironment === undefined)
    delete process.env.PLAID_ENVIRONMENT;
  else process.env.PLAID_ENVIRONMENT = previousPlaidEnvironment;
  if (previousPlaidClient === undefined) delete process.env.PLAID_CLIENT_ID;
  else process.env.PLAID_CLIENT_ID = previousPlaidClient;
});
mock.module("@midday/db/queries/hosted-bank-consents", () => ({
  getHostedBankCleanupBinding: async () => {
    if (bindingFailure)
      throw new Error("fixture SQL or encrypted binding unavailable");
    return consentBinding;
  },
  reconcileHostedBankConsents: async () => 0,
}));
let receiptFailure = false;
const begin = mock(async (_db: unknown, _id: string, ready: boolean) => {
  if (!ready) return { state: "pending", row };
  row = {
    ...row,
    status: "processing",
    attempts: row.attempts + 1,
    startedAt: "fixture-clock",
  };
  return { state: "claimed", row, token: "fixture-fence" };
});
const finish = mock(
  async (
    _db: unknown,
    _id: string,
    _token: string,
    outcome: BankCleanupOutcome,
  ) => {
    if (receiptFailure) throw new Error("fixture SQL failure");
    row = {
      ...row,
      status: outcome.status,
      encryptedPayload:
        outcome.status === "completed" ? null : row.encryptedPayload,
    };
    return row;
  },
);
const interrupt = mock(async () => {
  row.status = "reconciliation";
});
const configured = mock(() => true);
const revoke = mock(
  async (_target: BankCleanupTarget): Promise<BankCleanupOutcome> => ({
    status: "completed",
    reason: "revoked",
  }),
);
mock.module("@midday/db/queries/bank-connection-cleanups", () => ({
  getBankConnectionCleanup: async () => row,
  openBankConnectionCleanup: () => {
    if (!canOpen) throw new Error("fixture key unavailable");
    return target;
  },
  beginBankConnectionCleanup: begin,
  finishBankConnectionCleanup: finish,
  interruptBankConnectionCleanup: interrupt,
  listRecoverableBankConnectionCleanups: async () => [{ id: row.id }],
}));
mock.module("./db", () => ({ getDb: () => ({}) }));
const logs: unknown[] = [];
const telemetry: unknown[] = [];
mock.module("@sentry/bun", () => ({
  captureException: (...args: unknown[]) => {
    telemetry.push(args);
    return "fixture";
  },
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info(...args: unknown[]) {
      logs.push(args);
    },
    warn(...args: unknown[]) {
      logs.push(args);
    },
    error(...args: unknown[]) {
      logs.push(args);
    },
    debug() {},
  }),
}));
const { cleanupBankConnection } = await import("./bank-connection-cleanup");
const { DeleteTeamProcessor } = await import("../processors/teams/delete-team");
const db = {} as Database;

beforeEach(() => {
  row = {
    id: "cleanup-fixture",
    status: "pending",
    encryptedPayload: "frozen-ciphertext",
    attempts: 0,
    startedAt: null,
  };
  canOpen = true;
  consentBinding = null;
  bindingFailure = false;
  process.env.PLAID_ENVIRONMENT = "sandbox";
  process.env.PLAID_CLIENT_ID = "original-client";
  receiptFailure = false;
  logs.length = 0;
  telemetry.length = 0;
  begin.mockClear();
  finish.mockClear();
  interrupt.mockClear();
  configured.mockReset();
  configured.mockImplementation(() => true);
  revoke.mockReset();
  revoke.mockImplementation(async () => ({
    status: "completed",
    reason: "revoked",
  }));
});

describe("bank cleanup worker boundary", () => {
  test("native grants defer before HTTP when provider environment or client changes", async () => {
    consentBinding = hostedPlaidClientBinding(process.env)!;
    process.env.PLAID_ENVIRONMENT = "production";
    expect(
      await cleanupBankConnection(db, row.id, { configured, revoke }),
    ).toEqual({ status: "pending" });
    expect(revoke).not.toHaveBeenCalled();
    process.env.PLAID_ENVIRONMENT = "sandbox";
    process.env.PLAID_CLIENT_ID = "different-client";
    expect(
      await cleanupBankConnection(db, row.id, { configured, revoke }),
    ).toEqual({ status: "pending" });
    expect(revoke).not.toHaveBeenCalled();
    expect(row.encryptedPayload).toBe("frozen-ciphertext");
    expect(row.attempts).toBe(0);
    process.env.PLAID_CLIENT_ID = "original-client";
    expect(
      await cleanupBankConnection(db, row.id, { configured, revoke }),
    ).toEqual({ status: "completed" });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  test("an unreadable native binding cannot become an assumed legacy grant", async () => {
    bindingFailure = true;
    expect(
      await cleanupBankConnection(db, row.id, { configured, revoke }),
    ).toEqual({ status: "pending" });
    expect(begin).toHaveBeenCalledWith(db, row.id, false);
    expect(revoke).not.toHaveBeenCalled();
    expect(row.encryptedPayload).toBe("frozen-ciphertext");
  });

  test("missing configuration defers frozen credentials before claim or HTTP", async () => {
    configured.mockImplementation(() => false);
    expect(
      await cleanupBankConnection(db, row.id, { configured, revoke }),
    ).toEqual({ status: "pending" });
    expect(begin).toHaveBeenCalledWith(db, row.id, false);
    expect(row.attempts).toBe(0);
    expect(row.startedAt).toBeNull();
    expect(row.encryptedPayload).toBe("frozen-ciphertext");
    expect(revoke).not.toHaveBeenCalled();
  });
  test("lost encryption key cannot consume a provider attempt", async () => {
    canOpen = false;
    expect(
      (await cleanupBankConnection(db, row.id, { configured, revoke })).status,
    ).toBe("pending");
    expect(begin).toHaveBeenCalledWith(db, row.id, false);
    expect(revoke).not.toHaveBeenCalled();
  });
  test("configured success erases credentials and later jobs do not call the provider", async () => {
    expect(
      (await cleanupBankConnection(db, row.id, { configured, revoke })).status,
    ).toBe("completed");
    expect(row.encryptedPayload).toBeNull();
    expect(revoke).toHaveBeenCalledWith(target);
    configured.mockImplementation(() => false);
    expect(
      (await cleanupBankConnection(db, row.id, { configured, revoke })).status,
    ).toBe("completed");
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  test("uncertain acceptance is a visible terminal fence, never automatic replay", async () => {
    revoke.mockImplementation(async () => ({
      status: "reconciliation",
      reason: "provider_uncertain",
    }));
    expect(
      (await cleanupBankConnection(db, row.id, { configured, revoke })).status,
    ).toBe("reconciliation");
    expect(
      (await cleanupBankConnection(db, row.id, { configured, revoke })).status,
    ).toBe("reconciliation");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(row.encryptedPayload).toBe("frozen-ciphertext");
  });
  test("receipt persistence failure after provider acceptance fences rather than resends", async () => {
    receiptFailure = true;
    await expect(
      cleanupBankConnection(db, row.id, { configured, revoke }),
    ).rejects.toThrow("requires reconciliation");
    expect(interrupt).toHaveBeenCalledWith(db, row.id, "fixture-fence");
    expect(
      (await cleanupBankConnection(db, row.id, { configured, revoke })).status,
    ).toBe("reconciliation");
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  test("legacy secret-bearing delete-team jobs fail closed and never report cleanup success", async () => {
    const processor = new DeleteTeamProcessor();
    const job = {
      id: "legacy-fixture",
      name: "delete-team",
      opts: { attempts: 3, removeOnComplete: false },
      attemptsMade: 0,
      data: { teamId: "fixture-team", connections: [target] },
    } as unknown as Job<import("../schemas/teams").DeleteTeamPayload>;
    await expect(processor.handle(job)).rejects.toThrow(
      "operator reconciliation",
    );
    expect(revoke).not.toHaveBeenCalled();
    expect(telemetry).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(target.accessToken!);
    expect(JSON.stringify(telemetry)).not.toContain(target.accessToken!);
    expect(JSON.stringify(telemetry)).not.toContain(target.referenceId!);
    expect(job.data.connections[0]?.accessToken).toBe(target.accessToken);
  });
});
