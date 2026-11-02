import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { Database } from "@midday/db/client";
import type {
  InvoiceEmailDelivery,
  InvoiceEmailDeliveryScope,
} from "@midday/db/queries";
import {
  invoiceEmailEnvelopeHash,
  validateInvoiceEmailEnvelope,
} from "@midday/db/queries/invoice-email-deliveries";

// Real Notifications, render/encryption code, SDK and transport; only SQL
// persistence is simulated here. Separate PG tests verify every DB transition.
const savedFetch = globalThis.fetch;
const savedConnect = Socket.prototype.connect;
const savedKey = process.env.RESEND_API_KEY;
const savedEncryptionKey = process.env.MIDDAY_ENCRYPTION_KEY;
const identityKeys = [
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "DASHBOARD_URL",
  "APP_NAME",
  "TEAM_INVITATION_FROM",
] as const;
const savedIdentity = Object.fromEntries(
  identityKeys.map((key) => [key, process.env[key]]),
);
const forbidden = (): never => {
  throw new Error("Live network is forbidden in durable email tests");
};
Socket.prototype.connect = forbidden;

const teamId = "957e403d-765f-4c83-b51d-791a8d526341";
const userId = "cdf2ad61-427a-4f31-a908-b524481ad311";
const invoiceId = "3724fae5-0952-455c-b9a2-8ecb5f7e4574";
const scope = { teamId, invoiceId, operationKey: "a".repeat(64) };
const acceptedAt = "2026-11-01T06:00:00.000Z";
const rows = new Map<string, InvoiceEmailDelivery>();
const receipts = new Map<string, { body: string; id: string }>();
const requests: Array<{
  key: string;
  body: string;
  signal: AbortSignal | undefined | null;
}> = [];
let actualDeliveries = 0;
let activitiesCreated = 0;
let prepareCount = 0;
let failRecordOnce = false;
let failFinalizeOnce = false;
let forceStopped = false;
let firstResponseUncertain = false;
let rejectCode: { status: number; name: string } | null = null;
let providerWait: (() => Promise<void>) | undefined;
const events: string[] = [];

globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (
      String(input) !== "https://api.resend.com/emails" ||
      typeof init?.body !== "string"
    )
      return forbidden();
    const key = new Headers(init.headers).get("Idempotency-Key");
    if (!key)
      throw new Error("Durable requests require a provider idempotency key");
    requests.push({ key, body: init.body, signal: init.signal });
    events.push("http");
    await providerWait?.();
    if (rejectCode)
      return Response.json(
        {
          name: rejectCode.name,
          message: "Fixture rejection",
          statusCode: rejectCode.status,
        },
        { status: rejectCode.status },
      );
    let receipt = receipts.get(key);
    if (receipt && receipt.body !== init.body)
      return Response.json(
        {
          name: "invalid_idempotent_request",
          message: "Fixture payload mismatch",
          statusCode: 409,
        },
        { status: 409 },
      );
    if (!receipt) {
      actualDeliveries += 1;
      receipt = { body: init.body, id: `provider-${actualDeliveries}` };
      receipts.set(key, receipt);
    }
    if (firstResponseUncertain) {
      firstResponseUncertain = false;
      throw new Error("Connection lost after provider acceptance");
    }
    return Response.json({ id: receipt.id });
  },
  { preconnect: forbidden },
);

const rowFor = (s: InvoiceEmailDeliveryScope) => {
  const row = rows.get(s.operationKey);
  return row?.teamId === s.teamId && row.invoiceId === s.invoiceId ? row : null;
};
mock.module("@midday/db/queries", () => ({
  deferInvoiceEmailDelivery: async (
    _db: unknown,
    s: InvoiceEmailDeliveryScope,
  ) => {
    events.push("defer");
    const row = rowFor(s);
    if (!row) return { state: "missing", delivery: null };
    if (row.status === "accepted" || row.status === "completed")
      return { state: row.status, delivery: row };
    row.lastError = "configuration_unavailable";
    return { state: "deferred", delivery: row };
  },
  deferInvoiceEmailFinalization: async (
    _db: unknown,
    s: InvoiceEmailDeliveryScope,
  ) => {
    const row = rowFor(s);
    if (row?.status === "accepted") row.lastError = "finalization_retry";
  },
  invoiceEmailEnvelopeHash,
  validateInvoiceEmailEnvelope,
  getInvoiceEmailDelivery: async (_db: unknown, s: InvoiceEmailDeliveryScope) =>
    rowFor(s),
  prepareInvoiceEmailDelivery: async (_db: unknown, p: any) => {
    events.push("persist");
    prepareCount += 1;
    const row: InvoiceEmailDelivery = {
      id: randomUUID(),
      teamId: p.teamId,
      invoiceId: p.invoiceId,
      operationKey: p.operationKey,
      kind: p.kind,
      recipient: p.recipient,
      expectedScheduledJobId: p.expectedScheduledJobId ?? null,
      envelope: p.envelope,
      envelopeHash: invoiceEmailEnvelopeHash(p.envelope),
      activitySnapshot: p.activitySnapshot,
      status: "pending",
      attempts: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      firstAttemptAt: null,
      nextAttemptAt: acceptedAt,
      acceptedAt: null,
      completedAt: null,
      providerMessageId: null,
      lastError: null,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    };
    rows.set(p.operationKey, row);
    return row;
  },
  claimInvoiceEmailDelivery: async (
    _db: unknown,
    s: InvoiceEmailDeliveryScope,
  ) => {
    events.push("claim");
    const row = rowFor(s);
    if (!row) return { state: "missing", delivery: null };
    if (forceStopped) {
      row.status = "reconciliation";
      return { state: "stopped", delivery: row };
    }
    if (row.status === "accepted" || row.status === "completed")
      return { state: row.status, delivery: row };
    if (row.status === "sending") return { state: "busy", delivery: row };
    if (row.status !== "pending") return { state: "stopped", delivery: row };
    row.status = "sending";
    row.firstAttemptAt ??= acceptedAt;
    row.attempts += 1;
    row.leaseToken = randomUUID();
    return {
      state: "claimed",
      delivery: structuredClone(row),
      leaseToken: row.leaseToken,
    };
  },
  recordInvoiceDeliveryOutcome: async (
    _db: unknown,
    s: InvoiceEmailDeliveryScope & { leaseToken: string },
    outcome: any,
  ) => {
    events.push("receipt");
    if (failRecordOnce) {
      failRecordOnce = false;
      throw new Error("Database acknowledgement unavailable");
    }
    const row = rowFor(s);
    if (!row || row.leaseToken !== s.leaseToken) return null;
    row.leaseToken = null;
    if (outcome.kind === "accepted") {
      row.status = "accepted";
      row.acceptedAt = acceptedAt;
      row.providerMessageId = outcome.messageId;
    } else {
      row.status = outcome.kind === "retry" ? "pending" : outcome.kind;
      row.lastError = outcome.code;
    }
    return row;
  },
  finalizeInvoiceEmailDelivery: async (
    _db: unknown,
    s: InvoiceEmailDeliveryScope,
  ) => {
    events.push("finalize");
    if (failFinalizeOnce) {
      failFinalizeOnce = false;
      throw new Error("Fixture transaction rolled back");
    }
    const row = rowFor(s);
    if (!row || row.status === "completed") return row;
    if (row.status !== "accepted") throw new Error("No acceptance");
    activitiesCreated += row.activitySnapshot.length;
    row.activitySnapshot = [];
    row.envelope = null;
    row.status = "completed";
    row.completedAt = acceptedAt;
    return row;
  },
  getTeamMembers: async () => [
    {
      id: userId,
      role: "owner",
      fullName: "Fixture",
      email: "owner@example.test",
      avatarUrl: null,
      locale: "en",
    },
  ],
  getTeamById: async () => ({
    id: teamId,
    name: "Fixture team",
    inboxId: "fixture",
  }),
  shouldSendNotification: async () => true,
  createActivity: async () => {
    throw new Error("Durable activity must be committed by finalization");
  },
  updateActivityMetadata: async () => undefined,
  findRecentActivity: async () => undefined,
}));

let Notifications: typeof import("./index.js")["Notifications"];
let InvoiceDeliveryPendingError: typeof import("./services/durable-invoice-delivery.js")["InvoiceDeliveryPendingError"];
let InvoiceDeliveryStoppedError: typeof import("./services/durable-invoice-delivery.js")["InvoiceDeliveryStoppedError"];
beforeAll(async () => {
  ({ Notifications } = await import("./index.js"));
  ({ InvoiceDeliveryPendingError, InvoiceDeliveryStoppedError } = await import(
    "./services/durable-invoice-delivery.js"
  ));
});
const notifications = () => new Notifications({} as Database);
function send(operationKey = scope.operationKey, heading = "Original") {
  return notifications().create(
    "invoice_sent",
    teamId,
    {
      invoiceId,
      invoiceNumber: "INV-1",
      customerName: "Customer",
      customerEmail: "customer@example.test",
      token: "fixture-invoice-token",
      emailHeading: heading,
    },
    {
      sendEmail: true,
      requireEmailAcceptance: true,
      attachments: [{ filename: "invoice.pdf", content: "UERG" }],
      invoiceDelivery: { invoiceId, operationKey },
    },
  );
}

beforeEach(() => {
  delete process.env.TEAM_INVITATION_FROM;
  process.env.RESEND_API_KEY = "fixture-resend-key";
  process.env.EMAIL_FROM = "AGSaaS <accounts@example.test>";
  process.env.DASHBOARD_URL = "https://app.example.test";
  process.env.APP_NAME = "AGSaaS";
  delete process.env.EMAIL_REPLY_TO;
  process.env.MIDDAY_ENCRYPTION_KEY = "a".repeat(64);
  rows.clear();
  receipts.clear();
  requests.length = 0;
  events.length = 0;
  actualDeliveries = 0;
  activitiesCreated = 0;
  prepareCount = 0;
  failRecordOnce = false;
  failFinalizeOnce = false;
  forceStopped = false;
  firstResponseUncertain = false;
  rejectCode = null;
  providerWait = undefined;
});
afterEach(() => {
  for (const request of requests)
    expect(request.signal).toBeInstanceOf(AbortSignal);
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  Socket.prototype.connect = savedConnect;
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
  if (savedEncryptionKey === undefined)
    delete process.env.MIDDAY_ENCRYPTION_KEY;
  else process.env.MIDDAY_ENCRYPTION_KEY = savedEncryptionKey;
  for (const key of identityKeys) {
    if (savedIdentity[key] === undefined) delete process.env[key];
    else process.env[key] = savedIdentity[key];
  }
});

describe("durable invoice notification and actual SDK transport", () => {
  test("missing transport prepares intent but never starts the replay window or claims", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    const row = rows.get(scope.operationKey)!;
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      firstAttemptAt: null,
      leaseToken: null,
      lastError: "configuration_unavailable",
    });
    expect(events).toEqual(["persist", "defer"]);
    expect(requests).toHaveLength(0);

    const frozen = row.envelope;
    const frozenHash = row.envelopeHash;
    // Repeated recovery must not require or rebuild the original identity.
    delete process.env.EMAIL_FROM;
    delete process.env.DASHBOARD_URL;
    await expect(
      notifications().reconcileInvoiceDelivery(scope),
    ).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(row.envelope).toBe(frozen);
    expect(row.envelopeHash).toBe(frozenHash);
    expect(row.attempts).toBe(0);
    expect(row.firstAttemptAt).toBeNull();
    expect(events).not.toContain("claim");

    process.env.RESEND_API_KEY = "fixture-restored-key";
    await notifications().reconcileInvoiceDelivery(scope);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe(frozen!);
    expect(JSON.parse(requests[0]!.body).from).toBe(
      "AGSaaS <accounts@example.test>",
    );
  });

  test("missing transport after an uncertain attempt does not spend another attempt or replace bytes", async () => {
    firstResponseUncertain = true;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    const row = rows.get(scope.operationKey)!;
    const before = {
      firstAttemptAt: row.firstAttemptAt,
      attempts: row.attempts,
      envelope: row.envelope,
    };
    delete process.env.RESEND_API_KEY;
    await expect(
      notifications().reconcileInvoiceDelivery(scope),
    ).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(row).toMatchObject(before);
    expect(row.lastError).toBe("configuration_unavailable");
    expect(requests).toHaveLength(1);
    process.env.RESEND_API_KEY = "fixture-restored-key";
    await notifications().reconcileInvoiceDelivery(scope);
    expect(actualDeliveries).toBe(1);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(requests[1]?.key).toBe(requests[0]?.key);
  });

  test("accepted receipt finalizes with missing key and missing identity", async () => {
    failFinalizeOnce = true;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.DASHBOARD_URL;
    const recovered = await notifications().reconcileInvoiceDelivery(scope);
    expect(recovered.emails.recorded).toBe(true);
    expect(requests).toHaveLength(1);
    expect(activitiesCreated).toBe(1);
  });

  test("durable mode cannot silently override an explicit sendEmail=false", async () => {
    await expect(
      notifications().create(
        "invoice_sent",
        teamId,
        {
          invoiceId,
          invoiceNumber: "INV-1",
          customerName: "Customer",
          customerEmail: "customer@example.test",
          token: "fixture-token",
        },
        {
          sendEmail: false,
          requireEmailAcceptance: true,
          invoiceDelivery: { invoiceId, operationKey: scope.operationKey },
        },
      ),
    ).rejects.toThrow("explicit email acceptance");
    expect(prepareCount).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test("mutable URL attachments are rejected before persistence or HTTP", async () => {
    await expect(
      notifications().create(
        "invoice_sent",
        teamId,
        {
          invoiceId,
          invoiceNumber: "INV-1",
          customerName: "Customer",
          customerEmail: "customer@example.test",
          token: "fixture-token",
        },
        {
          sendEmail: true,
          requireEmailAcceptance: true,
          attachments: [
            {
              filename: "mutable.pdf",
              path: "https://example.test/latest.pdf",
            },
          ],
          invoiceDelivery: { invoiceId, operationKey: scope.operationKey },
        },
      ),
    ).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(prepareCount).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test("runtime recipient overrides cannot create a misleading invoice sentTo receipt", async () => {
    await expect(
      notifications().create(
        "invoice_sent",
        teamId,
        {
          invoiceId,
          invoiceNumber: "INV-1",
          customerName: "Customer",
          customerEmail: "customer@example.test",
          token: "fixture-token",
        },
        {
          sendEmail: true,
          requireEmailAcceptance: true,
          to: ["different@example.test"],
          invoiceDelivery: { invoiceId, operationKey: scope.operationKey },
        },
      ),
    ).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(prepareCount).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test("persist before HTTP, receipt before atomic finalization, duplicate completion has no side effects", async () => {
    const first = await send();
    const repeated = await send();
    expect(events.slice(0, 5)).toEqual([
      "persist",
      "claim",
      "http",
      "receipt",
      "finalize",
    ]);
    expect(first.emails.recorded).toBe(true);
    expect(repeated.emails.providerMessageIds).toEqual(
      first.emails.providerMessageIds,
    );
    expect(requests).toHaveLength(1);
    expect(activitiesCreated).toBe(1);
    expect(rows.get(scope.operationKey)?.envelope).toBeNull();
  });

  test("crash after provider success but before receipt write replays byte-identical payload/key", async () => {
    failRecordOnce = true;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    const row = rows.get(scope.operationKey)!;
    const frozen = row.envelope;
    row.status = "pending";
    row.leaseToken = null; // expired crash lease, covered by real PG test
    await send(scope.operationKey, "Changed after crash");
    expect(prepareCount).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toBe(frozen!);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(requests[1]?.key).toBe(requests[0]?.key);
    expect(actualDeliveries).toBe(1);
    expect(activitiesCreated).toBe(1);
  });

  test("a missing HTTP acknowledgement can replay the same persisted operation", async () => {
    firstResponseUncertain = true;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(rows.get(scope.operationKey)?.lastError).toBe("provider_uncertain");
    await notifications().reconcileInvoiceDelivery(scope);
    expect(prepareCount).toBe(1);
    expect(requests[0]?.key).toBe(requests[1]?.key);
    expect(actualDeliveries).toBe(1);
  });

  test("accepted receipt survives finalization failure and is recovered without HTTP", async () => {
    failFinalizeOnce = true;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(rows.get(scope.operationKey)?.status).toBe("accepted");
    expect(activitiesCreated).toBe(0);
    const recovered = await notifications().reconcileInvoiceDelivery(scope);
    expect(recovered.emails.recorded).toBe(true);
    expect(requests).toHaveLength(1);
    expect(activitiesCreated).toBe(1);
  });

  test("concurrent duplicates see an active claim and cannot submit another request", async () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    providerWait = async () => {
      started();
      await wait;
    };
    const first = send();
    await inFlight;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    expect(requests).toHaveLength(1);
    release();
    await first;
    expect(actualDeliveries).toBe(1);
  });

  test("expired/changed/attempt-exhausted claim stops without a new provider request", async () => {
    firstResponseUncertain = true;
    await expect(send()).rejects.toBeInstanceOf(InvoiceDeliveryPendingError);
    forceStopped = true;
    await expect(
      notifications().reconcileInvoiceDelivery(scope),
    ).rejects.toBeInstanceOf(InvoiceDeliveryStoppedError);
    expect(requests).toHaveLength(1);
  });

  test("envelope corruption fails closed before HTTP", async () => {
    failRecordOnce = true;
    await expect(send()).rejects.toThrow();
    const row = rows.get(scope.operationKey)!;
    row.status = "pending";
    row.leaseToken = null;
    row.envelope = "tampered bytes";
    await expect(
      notifications().reconcileInvoiceDelivery(scope),
    ).rejects.toBeInstanceOf(InvoiceDeliveryStoppedError);
    expect(row.lastError).toBe("envelope_integrity");
    expect(requests).toHaveLength(1);
  });

  for (const error of [
    { status: 429, name: "rate_limit_exceeded", kind: "pending" },
    { status: 409, name: "concurrent_idempotent_requests", kind: "pending" },
    { status: 409, name: "invalid_idempotent_request", kind: "reconciliation" },
    { status: 422, name: "validation_error", kind: "rejected" },
    { status: 500, name: "application_error", kind: "pending" },
  ] as const)
    test(`durable ${error.status}/${error.name} outcome is ${error.kind}`, async () => {
      rejectCode = error;
      await expect(send()).rejects.toThrow();
      expect(rows.get(scope.operationKey)?.status).toBe(error.kind);
      expect(activitiesCreated).toBe(0);
    });

  test("legitimate separate sends to one invoice use different provider operations", async () => {
    await send("a".repeat(64));
    await send("b".repeat(64));
    expect(requests[0]?.key).not.toBe(requests[1]?.key);
    expect(actualDeliveries).toBe(2);
    expect(activitiesCreated).toBe(2);
  });

  test("recovery never invents an operation missing from SQL", async () => {
    await expect(
      notifications().reconcileInvoiceDelivery(scope),
    ).rejects.toBeInstanceOf(InvoiceDeliveryStoppedError);
    expect(requests).toHaveLength(0);
    expect(prepareCount).toBe(0);
  });
});
