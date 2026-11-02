import {
  afterAll,
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
  TeamInviteDelivery,
  TeamInviteDeliveryOutcome,
  TeamInviteDeliveryScope,
} from "@midday/db/queries";
import {
  teamInviteEnvelopeHash,
  validateTeamInviteEnvelope,
} from "@midday/db/team-invite-delivery";

// The real email template, renderer, Resend SDK and provider classification run
// here. SQL transitions are simulated; the companion PG suite owns their proof.
const savedFetch = globalThis.fetch;
const savedConnect = Socket.prototype.connect;
const envNames = [
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "DASHBOARD_URL",
  "APP_NAME",
] as const;
const savedEnv = Object.fromEntries(
  envNames.map((name) => [name, process.env[name]]),
);
const forbidden = (): never => {
  throw new Error("Live network is forbidden in invitation email tests");
};
Socket.prototype.connect = forbidden;

const scope: TeamInviteDeliveryScope = {
  teamId: "f04e4d72-45ce-4ebe-bb61-49ace9eea8f2",
  inviteId: "d405da6d-8b06-4fb2-80c9-7ec60c85cabb",
  deliveryId: "ad417599-b777-497a-a9fd-a41111109443",
};
const fixtureTime = "2026-11-01T08:00:00.000Z";
let row: TeamInviteDelivery | null;
const requests: Array<{
  key: string;
  body: string;
  signal: AbortSignal | null | undefined;
}> = [];
const receipts = new Map<string, { body: string; id: string }>();
const events: string[] = [];
let actualDeliveries = 0;
let uncertainOnce = false;
let failRecordOnce = false;
let failRead = false;
let emptyReceipt = false;
let rejection: { status: number; name: string } | null = null;
let providerWait: (() => Promise<void>) | undefined;

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
    if (!key) throw new Error("Missing stable provider key");
    requests.push({ key, body: init.body, signal: init.signal });
    events.push("http");
    await providerWait?.();
    if (rejection)
      return Response.json(
        {
          name: rejection.name,
          message: "Fixture rejection",
          statusCode: rejection.status,
        },
        { status: rejection.status },
      );
    if (emptyReceipt) return Response.json({});
    let receipt = receipts.get(key);
    if (receipt && receipt.body !== init.body)
      return Response.json(
        {
          name: "invalid_idempotent_request",
          message: "Changed body",
          statusCode: 409,
        },
        { status: 409 },
      );
    if (!receipt) {
      actualDeliveries += 1;
      receipt = { body: init.body, id: `invite-provider-${actualDeliveries}` };
      receipts.set(key, receipt);
    }
    if (uncertainOnce) {
      uncertainOnce = false;
      throw new Error("Connection lost after acceptance");
    }
    return Response.json({ id: receipt.id });
  },
  { preconnect: forbidden },
);

const rowFor = (s: TeamInviteDeliveryScope) =>
  row &&
  row.teamId === s.teamId &&
  row.inviteId === s.inviteId &&
  row.id === s.deliveryId
    ? row
    : null;
mock.module("@midday/db/queries/team-invite-deliveries", () => ({
  getTeamInviteDelivery: async (_db: unknown, s: TeamInviteDeliveryScope) => {
    if (failRead)
      throw new Error(
        "SQL parameters contained private-recipient@example.test and secret HTML",
      );
    return rowFor(s);
  },
  prepareTeamInviteDelivery: async (
    _db: unknown,
    s: TeamInviteDeliveryScope,
    envelope: string,
  ) => {
    const current = rowFor(s);
    if (!current) return null;
    if (
      !current.envelope &&
      current.status === "pending" &&
      current.firstAttemptAt === null
    ) {
      events.push("persist");
      validateTeamInviteEnvelope(
        envelope,
        teamInviteEnvelopeHash(envelope),
        current.recipient,
      );
      current.envelope = envelope;
      current.envelopeHash = teamInviteEnvelopeHash(envelope);
    }
    return current;
  },
  deferTeamInviteDelivery: async (
    _db: unknown,
    s: TeamInviteDeliveryScope,
    code: string,
  ) => {
    const current = rowFor(s);
    if (current) current.lastError = code;
  },
  claimTeamInviteDelivery: async (_db: unknown, s: TeamInviteDeliveryScope) => {
    const current = rowFor(s);
    if (!current) return { state: "missing", delivery: null };
    if (current.status === "accepted")
      return { state: "accepted", delivery: current };
    if (current.status === "sending")
      return { state: "busy", delivery: current };
    if (current.status !== "pending")
      return { state: "stopped", delivery: current };
    if (!current.envelope) return { state: "unprepared", delivery: current };
    events.push("claim");
    current.status = "sending";
    current.firstAttemptAt ??= fixtureTime;
    current.attempts += 1;
    current.leaseToken = randomUUID();
    return {
      state: "claimed",
      delivery: structuredClone(current),
      leaseToken: current.leaseToken,
    };
  },
  recordTeamInviteDeliveryOutcome: async (
    _db: unknown,
    s: TeamInviteDeliveryScope & { leaseToken: string },
    outcome: TeamInviteDeliveryOutcome,
  ) => {
    events.push("receipt");
    if (failRecordOnce) {
      failRecordOnce = false;
      throw new Error(
        "SQL acknowledgement unavailable for private-recipient@example.test",
      );
    }
    const current = rowFor(s);
    if (!current || current.leaseToken !== s.leaseToken) return null;
    current.leaseToken = null;
    if (outcome.kind === "accepted") {
      current.status = "accepted";
      current.acceptedAt = fixtureTime;
      current.providerMessageId = outcome.messageId;
      current.envelope = null;
      current.lastError = null;
    } else {
      current.status = outcome.kind === "retry" ? "pending" : outcome.kind;
      current.lastError = outcome.code;
    }
    return current;
  },
}));
mock.module("@midday/db/queries", () => ({
  shouldSendNotification: async () => true,
}));

let deliverTeamInvitation: typeof import("./services/team-invitation-delivery.js")["deliverTeamInvitation"];
let TeamInvitationDeliveryPendingError: typeof import("./services/team-invitation-delivery.js")["TeamInvitationDeliveryPendingError"];
beforeAll(async () => {
  ({ deliverTeamInvitation, TeamInvitationDeliveryPendingError } = await import(
    "./services/team-invitation-delivery.js"
  ));
});
const send = () => deliverTeamInvitation({} as Database, scope);
beforeEach(() => {
  process.env.RESEND_API_KEY = "fixture-resend-key";
  process.env.EMAIL_FROM = "AGSaaS <invites@example.test>";
  process.env.DASHBOARD_URL = "https://workspace.example.test";
  process.env.APP_NAME = "AGSaaS";
  row = {
    id: scope.deliveryId,
    teamId: scope.teamId,
    inviteId: scope.inviteId,
    recipient: "invitee@example.test",
    context: {
      invitedByName: "Team owner",
      invitedByEmail: "owner@example.test",
      teamName: "Fixture team",
      locale: "en",
    },
    envelope: null,
    envelopeHash: null,
    status: "pending",
    attempts: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    firstAttemptAt: null,
    nextAttemptAt: fixtureTime,
    acceptedAt: null,
    providerMessageId: null,
    lastError: null,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
  };
  requests.length = 0;
  events.length = 0;
  receipts.clear();
  actualDeliveries = 0;
  uncertainOnce = false;
  failRecordOnce = false;
  failRead = false;
  emptyReceipt = false;
  rejection = null;
  providerWait = undefined;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  Socket.prototype.connect = savedConnect;
  for (const name of envNames) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("durable team invitation delivery", () => {
  test("persists the own-instance envelope before HTTP and records actual provider acceptance", async () => {
    expect(await send()).toEqual({ status: "accepted" });
    expect(events).toEqual(["persist", "claim", "http", "receipt"]);
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]!.body);
    expect(body.from).toBe("AGSaaS <invites@example.test>");
    expect(body.to).toEqual(["invitee@example.test"]);
    expect(body.html).toContain("https://workspace.example.test/teams");
    expect(body.html).toContain("AGSaaS");
    expect(body.html).not.toContain("app.midday.ai");
    expect(body.html).not.toContain("56.110.3.60");
    expect(requests[0]!.key).toBe(`agsaas-team-invite/${scope.deliveryId}`);
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(row?.providerMessageId).toBe("invite-provider-1");
    expect(row?.acceptedAt).toBe(fixtureTime);
    expect(row?.envelope).toBeNull();
  });

  test("a lost response replays identical bytes and key even after settings change", async () => {
    uncertainOnce = true;
    expect(await send()).toEqual({ status: "pending" });
    expect(row?.lastError).toBe("provider_uncertain");
    expect(row?.acceptedAt).toBeNull();
    process.env.EMAIL_FROM = "Changed <changed@example.test>";
    process.env.DASHBOARD_URL = "https://changed.example.test";
    row!.context.teamName = "Changed team name";
    expect(await send()).toEqual({ status: "accepted" });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(requests[1]!.key).toBe(requests[0]!.key);
    expect(actualDeliveries).toBe(1);
  });

  test("a crash recording the receipt recovers through the same provider operation", async () => {
    failRecordOnce = true;
    await expect(send()).rejects.toBeInstanceOf(
      TeamInvitationDeliveryPendingError,
    );
    expect(row?.status).toBe("sending");
    expect(row?.envelope).not.toBeNull();
    // The real PG suite verifies lease expiry; simulate the eligible retry here.
    row!.status = "pending";
    expect(await send()).toEqual({ status: "accepted" });
    expect(actualDeliveries).toBe(1);
    expect(requests[1]!.body).toBe(requests[0]!.body);
  });

  test("an accepted receipt makes queue replay a no-op", async () => {
    await send();
    delete process.env.RESEND_API_KEY;
    expect(await send()).toEqual({ status: "accepted" });
    expect(requests).toHaveLength(1);
    expect(actualDeliveries).toBe(1);
  });

  test("concurrent deliveries honor the persisted lease", async () => {
    let release!: () => void;
    let reached!: () => void;
    const inHttp = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    providerWait = () => {
      reached();
      return hold;
    };
    const first = send();
    await inHttp;
    expect(await send()).toEqual({ status: "pending" });
    release();
    expect(await first).toEqual({ status: "accepted" });
    expect(requests).toHaveLength(1);
  });

  test("an empty SDK receipt cannot become success", async () => {
    emptyReceipt = true;
    expect(await send()).toEqual({ status: "pending" });
    expect(row?.lastError).toBe("provider_uncertain");
    expect(row?.acceptedAt).toBeNull();
    expect(row?.providerMessageId).toBeNull();
  });

  test.each([
    [429, "rate_limit_exceeded", "pending", "provider_rate_limit"],
    [403, "validation_error", "rejected", "provider_rejected"],
    [
      409,
      "invalid_idempotent_request",
      "reconciliation",
      "provider_payload_conflict",
    ],
    [503, "application_error", "pending", "provider_uncertain"],
  ] as const)("provider status %s is recorded honestly", async (status, name, result, code) => {
    rejection = { status: Number(status), name: String(name) };
    expect(await send()).toEqual({ status: result });
    expect(row?.lastError).toBe(code);
    expect(row?.acceptedAt).toBeNull();
  });

  test("missing own-instance configuration defers without HTTP or a replay-window start", async () => {
    delete process.env.EMAIL_FROM;
    expect(await send()).toEqual({ status: "pending" });
    expect(row?.lastError).toBe("configuration_unavailable");
    expect(row?.firstAttemptAt).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test("a frozen unstarted envelope waits for the transport key without consuming an attempt", async () => {
    const frozen = JSON.stringify({
      from: "Original sender <original@example.test>",
      to: [row!.recipient],
      subject: "Original invitation",
      html: "<p>Original frozen invitation</p>",
    });
    row!.envelope = frozen;
    row!.envelopeHash = teamInviteEnvelopeHash(frozen);
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = "Changed sender <changed@example.test>";
    process.env.DASHBOARD_URL = "invalid-current-url";

    expect(await send()).toEqual({ status: "pending" });
    expect(row).toMatchObject({
      status: "pending",
      lastError: "configuration_unavailable",
      firstAttemptAt: null,
      attempts: 0,
      leaseToken: null,
      envelope: frozen,
      envelopeHash: teamInviteEnvelopeHash(frozen),
    });
    expect(events).toEqual([]);
    expect(requests).toHaveLength(0);

    // Restoring transport must replay the stored body, not validate or render
    // a replacement using the current sender/URL settings.
    process.env.RESEND_API_KEY = "restored-fixture-key";
    expect(await send()).toEqual({ status: "accepted" });
    expect(events).toEqual(["claim", "http", "receipt"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toBe(frozen);
    expect(row?.attempts).toBe(1);
  });

  test("removed or permanently stopped invitations never issue another request", async () => {
    row = null;
    expect(await send()).toEqual({ status: "canceled" });
    expect(requests).toHaveLength(0);
  });

  test.each([
    "canceled",
    "rejected",
    "reconciliation",
  ] as const)("%s is terminal", async (status) => {
    row!.status = status;
    expect(await send()).toEqual({ status });
    expect(requests).toHaveLength(0);
  });

  test("tampered persisted bytes stop before HTTP", async () => {
    uncertainOnce = true;
    await send();
    row!.envelope = `${row!.envelope} `;
    expect(await send()).toEqual({ status: "reconciliation" });
    expect(row?.lastError).toBe("envelope_integrity");
    expect(requests).toHaveLength(1);
  });

  test("database errors cannot leak recipient or envelope into BullMQ failure text", async () => {
    failRead = true;
    try {
      await send();
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TeamInvitationDeliveryPendingError);
      expect(String(error)).not.toContain("private-recipient");
      expect(String(error)).not.toContain("secret HTML");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
