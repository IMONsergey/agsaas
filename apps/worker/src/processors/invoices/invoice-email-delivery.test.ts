import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Socket } from "node:net";
import type { NotificationOptions } from "@midday/notifications";
import type { Job } from "bullmq";
import {
  canSendInvoiceEmail,
  canSendInvoiceReminder,
  isCurrentInvoiceSchedule,
} from "../../../../../packages/db/src/queries/invoice-delivery";
import { decodeJobId } from "../../../../../packages/job-client/src/utils";
import {
  assertEmailAccepted,
  EmailDeliveryError,
  type EmailDeliveryResult,
  emptyEmailDeliveryResult,
  isEmailAccepted,
} from "../../../../../packages/notifications/src/services/email-delivery-result";
import {
  type GenerateInvoicePayload,
  generateInvoiceSchema,
  type ScheduleInvoicePayload,
  type SendInvoiceEmailPayload,
  type SendInvoiceReminderPayload,
  sendInvoiceEmailSchema,
} from "../../schemas/invoices";
import {
  classifyError,
  NonRetryableError,
} from "../../utils/error-classification";

// Run in an isolated Bun process: actual processors, state predicates, delivery
// error contract and BaseProcessor; fake DB/provider/file boundaries only.
// Actual SQL/SDK contracts have their own PostgreSQL and notifications tests.
const previousFetch = globalThis.fetch;
const previousConnect = Socket.prototype.connect;
let networkAttempts = 0;
const blockNetwork = (): never => {
  networkAttempts += 1;
  throw new Error("Network is forbidden in invoice delivery processor tests");
};
globalThis.fetch = Object.assign(async () => blockNetwork(), {
  preconnect: blockNetwork,
});
Socket.prototype.connect = blockNetwork;

const invoiceId = "b81e124e-4e6b-4e29-97cd-e94010bccfed";
const teamId = "494c4720-6bf3-41b2-820d-59ce91414893";
const acceptedAt = "2026-10-31T12:00:00.000Z";
const scheduleVersion = "invoices:schedule-fixture-1";
const nextScheduleVersion = "invoices:schedule-fixture-2";
type InvoiceStatus = Parameters<typeof canSendInvoiceEmail>[0];
function fixtureInvoice() {
  return {
    id: invoiceId,
    teamId,
    status: "draft" as InvoiceStatus,
    invoiceNumber: "INV-1",
    token: "fixture-token",
    amount: 100,
    currency: "RUB",
    dueDate: "2026-11-10T00:00:00.000Z",
    customer: {
      name: "Fixture customer",
      email: "customer@example.test",
      billingEmail: "billing@example.test, accounts@example.test",
    },
    user: { email: "author@example.test" } as { email: string } | null,
    team: { email: "reply@example.test" },
    template: { includePdf: false, sendCopy: true },
    sentAt: null as string | null,
    reminderSentAt: null as string | null,
    scheduledJobId: scheduleVersion as string | null,
    invoiceRecurringId: null as string | null,
  };
}
function accepted(): EmailDeliveryResult {
  return {
    ...emptyEmailDeliveryResult(),
    sent: 1,
    providerMessageIds: ["provider-accepted-1"],
    acceptedAt,
  };
}

let invoice = fixtureInvoice();
let invoiceMissing = false;
let delivery = accepted();
let notificationError: unknown;
let writeError = false;
let writeMissing = false;
let notificationsConstructed = 0;
let storageConstructed = 0;
let duringSend: (() => Promise<void>) | undefined;
let duringAttachment: (() => void) | undefined;
let afterRead: (() => void) | undefined;
let duringRender: (() => void) | undefined;
let duringUpload: (() => void) | undefined;
let rendered = 0;
let uploaded = 0;
let queueFailure = false;
let intentFailure = false;
let durableReceipt: "pending" | "accepted" | "completed" | null = null;
let durableFinalizations = 0;
let durableRecoveries = 0;
const queued: Array<{ name: string; payload: unknown }> = [];
const documentsQueued: Array<{ name: string; payload: unknown }> = [];
const fileWrites: Array<Record<string, unknown>> = [];
const uploadedPaths: string[] = [];
const notificationCalls: Array<{
  type: string;
  teamId: string;
  payload: unknown;
  options: NotificationOptions;
}> = [];
const writes: Array<{
  kind: "invoice" | "reminder";
  invoiceId: string;
  teamId: string;
  acceptedAt: string;
  recipient?: string;
  expectedScheduledJobId?: string;
}> = [];

mock.module("@midday/db/queries", () => ({
  reserveGeneratedStorage: async () => {},
  INVOICE_EMAIL_ENVELOPE_MAX_BYTES: 4 * 1024 * 1024,
  deferInvoiceEmailFinalization: async () => undefined,
  canSendInvoiceEmail,
  canSendInvoiceReminder,
  isCurrentInvoiceSchedule,
  getInvoiceById: async () => {
    const snapshot = invoiceMissing ? undefined : structuredClone(invoice);
    afterRead?.();
    return snapshot;
  },
  prepareInvoiceDocument: async (
    _db: unknown,
    params: { expectedScheduledJobId?: string },
  ) =>
    invoiceMissing ||
    (params.expectedScheduledJobId !== undefined &&
      !isCurrentInvoiceSchedule(invoice, params.expectedScheduledJobId))
      ? null
      : structuredClone(invoice),
  getInvoiceDocumentById: async () => {
    const snapshot = invoiceMissing ? undefined : structuredClone(invoice);
    afterRead?.();
    return snapshot;
  },
  getInvoiceEmailDelivery: async () =>
    durableReceipt ? { status: durableReceipt } : null,
  finalizeInvoiceEmailDelivery: async () => {
    durableFinalizations += 1;
    if (writeError)
      throw new Error("SQL parameters contain customer@example.test");
    if (writeMissing) return null;
    durableReceipt = "completed";
    return { status: "completed" };
  },
  updateInvoice: async (_db: unknown, params: Record<string, unknown>) => {
    const { id, teamId: invoiceTeamId, filePath, fileSize, ...other } = params;
    if (Object.keys(other).length > 0 || !filePath || !fileSize) {
      throw new Error("Delivery must never use an unconditional status update");
    }
    expect(id).toBe(invoiceId);
    expect(invoiceTeamId).toBe(teamId);
    fileWrites.push(params);
    return { id };
  },
  recordInvoiceEmailAccepted: async (
    _db: unknown,
    params: {
      invoiceId: string;
      teamId: string;
      recipient: string;
      acceptedAt: string;
      expectedScheduledJobId?: string;
    },
  ) => {
    writes.push({ kind: "invoice", ...params });
    if (writeError) throw new Error("Fixture acceptance write failed");
    if (writeMissing) return undefined;
    invoice.sentAt = params.acceptedAt;
    return { id: invoiceId, status: invoice.status, sentAt: params.acceptedAt };
  },
  recordInvoiceReminderAccepted: async (
    _db: unknown,
    params: {
      invoiceId: string;
      teamId: string;
      acceptedAt: string;
    },
  ) => {
    writes.push({ kind: "reminder", ...params });
    if (writeError) throw new Error("Fixture acceptance write failed");
    if (writeMissing) return undefined;
    invoice.reminderSentAt = params.acceptedAt;
    return {
      id: invoiceId,
      status: invoice.status,
      reminderSentAt: params.acceptedAt,
    };
  },
}));
mock.module("@midday/db/queries/financial-job-dispatches", () => ({
  ensureFinancialJobDispatch: async (
    _db: unknown,
    input: { jobName: string; source: string; payload: unknown },
  ) => {
    if (intentFailure) throw new Error("Fixture SQL intent unavailable");
    if (
      !queued.some(
        (job) =>
          job.name === input.jobName &&
          JSON.stringify(job.payload) === JSON.stringify(input.payload),
      )
    ) {
      queued.push({ name: input.jobName, payload: input.payload });
    }
    return { id: "intent-fixture", status: "pending" };
  },
}));
mock.module("@midday/db/worker-client", () => ({ getWorkerDb: () => ({}) }));
mock.module("@midday/job-client", () => ({ decodeJobId }));
// These processor fixtures use fake queues. Admission has its own real-Redis
// generation/lock race gate; no production Redis is opened by money fixtures.
mock.module("@midday/job-client/resource-admission", () => ({
  queuePayloadTeam: (payload: { teamId?: string } | null) =>
    payload?.teamId ?? null,
  reserveQueuedJob: async (_queue: string, _payload: unknown, id?: string) =>
    id ?? crypto.randomUUID(),
  captureQueuedJobReservation: async () => ({
    generation: "fixture-admission",
    retry: "none",
  }),
  captureWorkerQueuedJobReservation: async () => ({
    generation: "fixture-admission",
    retry: "none",
  }),
  releaseQueuedJob: async () => true,
  releaseWorkerQueuedJobReservation: async () => true,
}));
mock.module("../../queues/invoices", () => ({
  invoicesQueue: {
    add: async (name: string, payload: unknown) => {
      if (queueFailure) throw new Error("Fixture queue unavailable");
      queued.push({ name, payload });
      return { id: "generation-fixture-1" };
    },
  },
}));
mock.module("../../queues/documents", () => ({
  documentsQueue: {
    add: async (name: string, payload: unknown) => {
      documentsQueued.push({ name, payload });
      return { id: "document-fixture-1" };
    },
  },
}));
mock.module("@midday/invoice", () => ({
  PdfTemplate: async () => ({}),
  renderToBuffer: async () => {
    rendered += 1;
    duringRender?.();
    return Buffer.from("Fixture PDF");
  },
}));
mock.module("@midday/notifications", () => ({
  assertEmailAccepted,
  EmailDeliveryError,
  emptyEmailDeliveryResult,
  isEmailAccepted,
  Notifications: class {
    constructor() {
      notificationsConstructed += 1;
    }
    async reconcileInvoiceDelivery() {
      durableRecoveries += 1;
      return {
        type: "invoice_sent",
        activities: 0,
        emails: { ...accepted(), recorded: true },
      };
    }
    async create(
      type: string,
      notificationTeamId: string,
      payload: unknown,
      options: NotificationOptions,
    ) {
      notificationCalls.push({
        type,
        teamId: notificationTeamId,
        payload,
        options,
      });
      await duringSend?.();
      if (notificationError) throw notificationError;
      return { type, activities: 1, emails: delivery };
    }
  },
}));
mock.module("@midday/supabase/job", () => ({
  createTeamClient: () => {
    storageConstructed += 1;
    return {
      storage: {
        from: () => ({
          download: async () => {
            duringAttachment?.();
            return { data: new Blob(["Fixture PDF"]), error: null };
          },
          upload: async (path: string) => {
            uploadedPaths.push(path);
            uploaded += 1;
            duringUpload?.();
            return { error: null };
          },
        }),
      },
    };
  },
}));
mock.module("@midday/logger", () => ({
  createLoggerWithContext: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
  }),
}));
mock.module("@sentry/bun", () => ({ captureException() {} }));

const { SendInvoiceEmailProcessor } = await import("./send-invoice-email");
const { SendInvoiceReminderProcessor } = await import(
  "./send-invoice-reminder"
);
const { ScheduleInvoiceProcessor } = await import("./schedule-invoice");
const { GenerateInvoiceProcessor } = await import("./generate-invoice");
const sendProcessor = new SendInvoiceEmailProcessor();
const reminderProcessor = new SendInvoiceReminderProcessor();
const scheduleProcessor = new ScheduleInvoiceProcessor();
const generateProcessor = new GenerateInvoiceProcessor();

function sendJob(): Job<SendInvoiceEmailPayload> {
  return {
    id: "send-fixture-1",
    timestamp: 1793448000000,
    name: "send-invoice-email",
    attemptsMade: 0,
    opts: { attempts: 3, removeOnComplete: false },
    data: {
      invoiceId,
      filename: "fixture.pdf",
      fullPath: `${teamId}/invoices/fixture.pdf`,
    },
  } as Job<SendInvoiceEmailPayload>;
}
function reminderJob(): Job<SendInvoiceReminderPayload> {
  return {
    id: "reminder-fixture-1",
    timestamp: 1793448000000,
    name: "send-invoice-reminder",
    attemptsMade: 0,
    opts: { attempts: 3, removeOnComplete: false },
    data: { invoiceId },
  } as Job<SendInvoiceReminderPayload>;
}

function scheduleJob(): Job<ScheduleInvoicePayload> {
  return {
    ...reminderJob(),
    id: "schedule-fixture-1",
    name: "schedule-invoice",
  } as Job<ScheduleInvoicePayload>;
}

function generateJob(
  data: GenerateInvoicePayload,
): Job<GenerateInvoicePayload> {
  return {
    ...sendJob(),
    id: "generation-fixture-1",
    name: "generate-invoice",
    data,
  } as Job<GenerateInvoicePayload>;
}

function queuedGenerationJob(): Job<GenerateInvoicePayload> {
  return generateJob(
    generateInvoiceSchema.parse(
      queued.find((job) => job.name === "generate-invoice")?.payload,
    ),
  );
}

function queuedSendJob(): Job<SendInvoiceEmailPayload> {
  const job = sendJob();
  job.data = sendInvoiceEmailSchema.parse(
    queued.find((queuedJob) => queuedJob.name === "send-invoice-email")
      ?.payload,
  );
  return job;
}

function versionedSendJob(): Job<SendInvoiceEmailPayload> {
  const job = sendJob();
  job.data.expectedScheduledJobId = scheduleVersion;
  return job;
}

beforeEach(() => {
  invoice = fixtureInvoice();
  invoiceMissing = false;
  delivery = accepted();
  notificationError = undefined;
  writeError = false;
  writeMissing = false;
  notificationsConstructed = 0;
  storageConstructed = 0;
  duringSend = undefined;
  duringAttachment = undefined;
  afterRead = undefined;
  duringRender = undefined;
  duringUpload = undefined;
  rendered = 0;
  uploaded = 0;
  queueFailure = false;
  intentFailure = false;
  durableReceipt = null;
  durableFinalizations = 0;
  durableRecoveries = 0;
  queued.length = 0;
  documentsQueued.length = 0;
  fileWrites.length = 0;
  uploadedPaths.length = 0;
  notificationCalls.length = 0;
  writes.length = 0;
  networkAttempts = 0;
});
afterEach(() => expect(networkAttempts).toBe(0));
afterAll(() => {
  globalThis.fetch = previousFetch;
  Socket.prototype.connect = previousConnect;
});

describe("scheduled invoice handoff", () => {
  test("queueing PDF/email is not a financial status transition", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    expect(queued).toEqual([
      {
        name: "generate-invoice",
        payload: {
          invoiceId,
          deliveryType: "create_and_send",
          expectedScheduledJobId: scheduleVersion,
        },
      },
    ]);
    expect(invoice.status).toBe("scheduled");
    expect(invoice.scheduledJobId).toBe("invoices:schedule-fixture-1");
    expect(invoice.sentAt).toBeNull();
  });

  test("queue failure leaves the schedule marker and status available for retry", async () => {
    invoice.status = "scheduled";
    queueFailure = true;
    await expect(scheduleProcessor.handle(scheduleJob())).rejects.toThrow(
      "Fixture queue unavailable",
    );
    expect(invoice.status).toBe("scheduled");
    expect(invoice.scheduledJobId).toBe("invoices:schedule-fixture-1");
    queueFailure = false;
    intentFailure = false;
    await scheduleProcessor.handle(scheduleJob());
    expect(queued).toHaveLength(1);
  });

  for (const status of ["paid", "canceled", "refunded"] as const) {
    test(`a racing ${status} transition cannot be overwritten by scheduling`, async () => {
      invoice.status = "scheduled";
      afterRead = () => {
        invoice.status = status;
      };
      await scheduleProcessor.handle(scheduleJob());
      expect<InvoiceStatus>(invoice.status).toBe(status);
      expect(invoice.sentAt).toBeNull();
      // The downstream sender rechecks status; scheduler never sends a letter.
      expect(notificationCalls).toHaveLength(0);
    });
  }

  test("an already terminal or rescheduled invoice is not queued", async () => {
    invoice.status = "paid";
    await scheduleProcessor.handle(scheduleJob());
    invoice.status = "scheduled";
    invoice.scheduledJobId = "invoices:newer-schedule";
    await scheduleProcessor.handle(scheduleJob());
    expect(queued).toHaveLength(0);
  });

  for (const marker of [
    null,
    "",
    "not-a-composite-id",
    "documents:schedule-fixture-1",
  ]) {
    test(`a missing or invalid schedule marker cannot create an unversioned handoff: ${marker}`, async () => {
      invoice.status = "scheduled";
      invoice.scheduledJobId = marker;
      await scheduleProcessor.handle(scheduleJob());
      expect(queued).toHaveLength(0);
    });
  }
});

describe("canonical invoice PDF identity", () => {
  test("display numbers cannot select another PDF object, including raw and encoded traversal", async () => {
    for (const invoiceNumber of [
      "INV-1",
      "../../another-team/invoices/INV-1",
      "%2e%2e/%2e%2e/other",
    ]) {
      invoice.invoiceNumber = invoiceNumber;
      await generateProcessor.handle(
        generateJob({ invoiceId, deliveryType: "create" }),
      );
      expect(uploadedPaths.at(-1)).toBe(`${teamId}/invoices/${invoiceId}.pdf`);
      expect(fileWrites.at(-1)?.filePath).toEqual([
        teamId,
        "invoices",
        `${invoiceId}.pdf`,
      ]);
    }
  });
});

describe("versioned scheduled invoice pipeline", () => {
  test("a fresh schedule carries the exact marker through generation, schema parsing and acceptance", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    const generation = queuedGenerationJob();
    expect(generation.data.expectedScheduledJobId).toBe(scheduleVersion);
    await generateProcessor.handle(generation);
    const send = queuedSendJob();
    expect(send.data.expectedScheduledJobId).toBe(scheduleVersion);
    expect(invoice.status).toBe("scheduled");
    expect(invoice.sentAt).toBeNull();
    await sendProcessor.handle(send);
    expect(notificationCalls).toHaveLength(1);
    expect(writes).toEqual([
      {
        kind: "invoice",
        invoiceId,
        teamId,
        recipient: "customer@example.test",
        acceptedAt,
        expectedScheduledJobId: scheduleVersion,
      },
    ]);
    expect(invoice.sentAt).toBe(acceptedAt);
    expect(fileWrites).toHaveLength(1);
    expect(documentsQueued).toHaveLength(1);
  });

  test("rescheduling while generation is queued invalidates the old generation before external work", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    invoice.scheduledJobId = nextScheduleVersion;
    await generateProcessor.handle(queuedGenerationJob());
    expect(rendered).toBe(0);
    expect(storageConstructed).toBe(0);
    expect(queued.map((job) => job.name)).toEqual(["generate-invoice"]);
    expect(fileWrites).toHaveLength(0);
  });

  test("rescheduling during PDF rendering is rechecked before upload or email enqueue", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    duringRender = () => {
      invoice.scheduledJobId = nextScheduleVersion;
    };
    await generateProcessor.handle(queuedGenerationJob());
    expect(rendered).toBe(1);
    expect(uploaded).toBe(0);
    expect(storageConstructed).toBe(0);
    expect(queued.map((job) => job.name)).toEqual(["generate-invoice"]);
  });

  test("a reschedule during upload cannot replace the original marker in queued email", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    duringUpload = () => {
      invoice.scheduledJobId = nextScheduleVersion;
    };
    await generateProcessor.handle(queuedGenerationJob());
    const send = queuedSendJob();
    expect(send.data.expectedScheduledJobId).toBe(scheduleVersion);
    await sendProcessor.handle(send);
    expect(notificationCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(invoice.scheduledJobId).toBe(nextScheduleVersion);
  });

  test("cancelSchedule to draft invalidates an email already queued by the old schedule", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    await generateProcessor.handle(queuedGenerationJob());
    invoice.status = "draft";
    invoice.scheduledJobId = null;
    await sendProcessor.handle(queuedSendJob());
    expect(notificationCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(invoice.sentAt).toBeNull();
  });

  test("rescheduling an already queued email skips the old send before provider construction", async () => {
    invoice.status = "scheduled";
    await scheduleProcessor.handle(scheduleJob());
    await generateProcessor.handle(queuedGenerationJob());
    invoice.scheduledJobId = nextScheduleVersion;
    await sendProcessor.handle(queuedSendJob());
    expect(notificationsConstructed).toBe(0);
    expect(writes).toHaveLength(0);
    expect(invoice.scheduledJobId).toBe(nextScheduleVersion);
  });

  test("a schedule changed during PDF attachment preparation is rechecked before the provider", async () => {
    invoice.status = "scheduled";
    invoice.template.includePdf = true;
    duringAttachment = () => {
      invoice.scheduledJobId = nextScheduleVersion;
    };
    await sendProcessor.handle(versionedSendJob());
    expect(storageConstructed).toBe(1);
    expect(notificationsConstructed).toBe(0);
    expect(writes).toHaveLength(0);
  });

  for (const status of ["draft", "unpaid", "overdue"] as const) {
    test(`a versioned send cannot use the ordinary ${status} resend permission`, async () => {
      invoice.status = status;
      await sendProcessor.handle(versionedSendJob());
      expect(notificationsConstructed).toBe(0);
      expect(writes).toHaveLength(0);
    });
  }

  test("reschedule while provider HTTP is in flight retains the old expected marker in the acceptance write", async () => {
    invoice.status = "scheduled";
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const providerResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    duringSend = async () => {
      started();
      await providerResponse;
    };
    const processing = sendProcessor.handle(versionedSendJob());
    await inFlight;
    invoice.scheduledJobId = nextScheduleVersion;
    release();
    await processing;
    expect(notificationCalls).toHaveLength(1);
    expect(invoice.sentAt).toBe(acceptedAt);
    expect(writes[0]?.expectedScheduledJobId).toBe(scheduleVersion);
    expect(writes[0]).not.toHaveProperty("status");
    // Current-row SQL marker/status preservation is asserted in the PG suite.
    expect(invoice.scheduledJobId).toBe(nextScheduleVersion);
  });

  test("manual and recurring generation remain unversioned and can send drafts", async () => {
    invoice.status = "draft";
    invoice.invoiceRecurringId = "d8157c57-512e-4e55-86bb-5ffbdddbda0f";
    invoice.scheduledJobId = null;
    await generateProcessor.handle(
      generateJob({ invoiceId, deliveryType: "create_and_send" }),
    );
    const send = queuedSendJob();
    expect(send.data.expectedScheduledJobId).toBeUndefined();
    await sendProcessor.handle(send);
    expect(notificationCalls).toHaveLength(1);
    expect(writes[0]).not.toHaveProperty("expectedScheduledJobId");
  });

  test("payload schemas preserve a version and reject an empty one instead of treating it as manual", () => {
    expect(() =>
      generateInvoiceSchema.parse({
        invoiceId,
        deliveryType: "create_and_send",
        expectedScheduledJobId: "",
      }),
    ).toThrow();
    expect(() =>
      sendInvoiceEmailSchema.parse({
        ...sendJob().data,
        expectedScheduledJobId: "",
      }),
    ).toThrow();
  });
});

describe("invoice send processor", () => {
  test("known acceptance is finalized after payment without touching storage or provider", async () => {
    invoice.status = "paid";
    invoice.template.includePdf = true;
    durableReceipt = "accepted";
    await sendProcessor.handle(sendJob());
    expect(durableFinalizations).toBe(1);
    expect<string | null>(durableReceipt).toBe("completed");
    expect(notificationsConstructed).toBe(0);
    expect(storageConstructed).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("a persisted operation bypasses mutable PDF and notification reconstruction", async () => {
    invoice.template.includePdf = true;
    durableReceipt = "pending";
    await sendProcessor.handle(sendJob());
    expect(durableRecoveries).toBe(1);
    expect(storageConstructed).toBe(0);
    expect(notificationCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test("an atomically finalized notification does not run a second invoice write", async () => {
    delivery = { ...accepted(), recorded: true };
    await sendProcessor.handle(sendJob());
    expect(notificationCalls).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect(notificationCalls[0]?.options.invoiceDelivery?.operationKey).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  test("receipt finalization errors do not leak SQL parameters or return false success", async () => {
    durableReceipt = "accepted";
    writeError = true;
    await expect(sendProcessor.handle(sendJob())).rejects.toThrow(
      "temporarily unavailable",
    );
    writeError = false;
    writeMissing = true;
    await expect(sendProcessor.handle(sendJob())).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(notificationCalls).toHaveLength(0);
  });

  for (const status of ["paid", "canceled", "refunded"] as const) {
    test(`a queued ${status} invoice is skipped before any external clients`, async () => {
      invoice.status = status;
      invoice.template.includePdf = true;
      await sendProcessor.handle(sendJob());
      expect(notificationsConstructed).toBe(0);
      expect(storageConstructed).toBe(0);
      expect(notificationCalls).toEqual([]);
      expect(writes).toEqual([]);
    });
  }

  for (const status of ["draft", "scheduled", "unpaid", "overdue"] as const) {
    test(`${status} uses the conditional acceptance write after acknowledgement`, async () => {
      invoice.status = status;
      await sendProcessor.handle(sendJob());
      expect(notificationCalls[0]?.options.requireEmailAcceptance).toBe(true);
      expect(writes).toEqual([
        {
          kind: "invoice",
          invoiceId,
          teamId,
          acceptedAt,
          recipient: "customer@example.test",
        },
      ]);
      expect(notificationCalls[0]?.options.bcc).toEqual([
        "billing@example.test",
        "accounts@example.test",
        "author@example.test",
      ]);
    });
  }

  test("historical invoice with a deleted author still sends without an author copy", async () => {
    invoice.user = null;
    await sendProcessor.handle(sendJob());
    expect(notificationCalls[0]?.options.bcc).toEqual([
      "billing@example.test",
      "accounts@example.test",
    ]);
    expect(writes).toHaveLength(1);
  });

  test("payment during attachment preparation prevents the email call", async () => {
    invoice.template.includePdf = true;
    duringAttachment = () => {
      invoice.status = "paid";
    };
    await sendProcessor.handle(sendJob());
    expect(storageConstructed).toBe(1);
    expect(notificationsConstructed).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("a payment while provider HTTP is in flight is not overwritten", async () => {
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const providerResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    duringSend = async () => {
      started();
      await providerResponse;
    };
    const processing = sendProcessor.handle(sendJob());
    await inFlight;
    invoice.status = "paid";
    release();
    await processing;
    expect(invoice.status).toBe("paid");
    expect(invoice.sentAt).toBe(acceptedAt);
    expect(writes[0]).not.toHaveProperty("status");
    expect(writes[0]?.teamId).toBe(teamId);
  });

  test("no invoice cannot cause a provider call", async () => {
    invoiceMissing = true;
    await expect(sendProcessor.handle(sendJob())).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(notificationCalls).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("failed, ambiguous and retried email outcomes", () => {
  test("zero accepted emails cannot stamp an invoice as sent", async () => {
    delivery = emptyEmailDeliveryResult();
    await expect(sendProcessor.handle(sendJob())).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(invoice.sentAt).toBeNull();
    expect(writes).toEqual([]);
  });

  test("confirmed transient provider rejection may retry, then record one acceptance", async () => {
    delivery = { ...emptyEmailDeliveryResult(), failed: 1, retryable: true };
    try {
      await sendProcessor.handle(sendJob());
      throw new Error("Expected provider rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).not.toBeInstanceOf(NonRetryableError);
      expect(classifyError(error).retryable).toBe(true);
    }
    expect(writes).toHaveLength(0);
    delivery = accepted();
    const retry = sendJob();
    retry.attemptsMade = 1;
    await sendProcessor.handle(retry);
    expect(notificationCalls).toHaveLength(2);
    expect(writes).toHaveLength(1);
    expect(invoice.sentAt).toBe(acceptedAt);
  });

  for (const result of [
    { ...emptyEmailDeliveryResult(), failed: 1 },
    { ...emptyEmailDeliveryResult(), failed: 1, uncertain: 1 },
    { ...accepted(), failed: 1 },
  ]) {
    test(`unsafe retry is stopped for outcome ${JSON.stringify(result)}`, async () => {
      delivery = result;
      await expect(sendProcessor.handle(sendJob())).rejects.toBeInstanceOf(
        NonRetryableError,
      );
      expect(writes).toHaveLength(0);
      expect(invoice.sentAt).toBeNull();
    });
  }

  test("failure before provider invocation does not lose safe retries", async () => {
    notificationError = new Error("Fixture database temporarily unavailable");
    await expect(sendProcessor.handle(sendJob())).rejects.not.toBeInstanceOf(
      NonRetryableError,
    );
    expect(writes).toHaveLength(0);
    notificationError = undefined;
    await sendProcessor.handle(sendJob());
    expect(writes).toHaveLength(1);
  });

  test("acceptance followed by a failed DB write requires reconciliation, never blind resend", async () => {
    writeError = true;
    await expect(sendProcessor.handle(sendJob())).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(notificationCalls).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  test("a disappearing invoice after acceptance is not reported as success", async () => {
    writeMissing = true;
    await expect(sendProcessor.handle(sendJob())).rejects.toThrow(
      "reconciliation required",
    );
    expect(notificationCalls).toHaveLength(1);
  });

  test("activity failure after provider acceptance still records the acceptance once", async () => {
    notificationError = new EmailDeliveryError(accepted(), "activity");
    await expect(sendProcessor.handle(sendJob())).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(invoice.sentAt).toBe(acceptedAt);
    expect(writes).toHaveLength(1);
    expect(notificationCalls).toHaveLength(1);
  });
});

describe("invoice reminder processor", () => {
  for (const status of [
    "draft",
    "scheduled",
    "paid",
    "canceled",
    "refunded",
  ] as const) {
    test(`${status} reminders are skipped before notification construction`, async () => {
      invoice.status = status;
      await reminderProcessor.handle(reminderJob());
      expect(notificationsConstructed).toBe(0);
      expect(writes).toEqual([]);
      expect(invoice.reminderSentAt).toBeNull();
    });
  }

  for (const status of ["unpaid", "overdue"] as const) {
    test(`${status} reminder timestamp is the provider acceptance time`, async () => {
      invoice.status = status;
      await reminderProcessor.handle(reminderJob());
      expect(notificationCalls[0]?.options.requireEmailAcceptance).toBe(true);
      expect(writes).toEqual([
        { kind: "reminder", invoiceId, teamId, acceptedAt },
      ]);
      expect(invoice.reminderSentAt).toBe(acceptedAt);
    });
  }

  test("failed reminders do not write a timestamp", async () => {
    invoice.status = "unpaid";
    delivery = { ...emptyEmailDeliveryResult(), failed: 1, retryable: true };
    await expect(
      reminderProcessor.handle(reminderJob()),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(invoice.reminderSentAt).toBeNull();
    expect(writes).toHaveLength(0);
  });

  test("payment during a reminder call preserves paid status and actual acceptance", async () => {
    invoice.status = "unpaid";
    duringSend = async () => {
      invoice.status = "paid";
    };
    await reminderProcessor.handle(reminderJob());
    expect<InvoiceStatus>(invoice.status).toBe("paid");
    expect(invoice.reminderSentAt).toBe(acceptedAt);
    expect(writes[0]).not.toHaveProperty("status");
  });

  test("separate legitimate reminders are not deduplicated just by invoice ID", async () => {
    invoice.status = "unpaid";
    await reminderProcessor.handle(reminderJob());
    delivery = { ...accepted(), acceptedAt: "2026-11-01T12:00:00.000Z" };
    const next = reminderJob();
    next.id = "reminder-fixture-2";
    await reminderProcessor.handle(next);
    expect(notificationCalls).toHaveLength(2);
    expect(writes).toHaveLength(2);
    expect(invoice.reminderSentAt).toBe(delivery.acceptedAt!);
  });
});

describe("generation durable email handoff", () => {
  test("SQL intent failure keeps generation retryable and no email intent is invented", async () => {
    invoice.status = "unpaid";
    intentFailure = true;
    const job = generateJob({
      invoiceId,
      deliveryType: "create_and_send",
      deliveryKey: "a".repeat(64),
    });
    await expect(generateProcessor.handle(job)).rejects.toThrow(
      "SQL intent unavailable",
    );
    expect(
      queued.filter((item) => item.name === "send-invoice-email"),
    ).toHaveLength(0);
    expect(notificationCalls).toHaveLength(0);
    intentFailure = false;
    await generateProcessor.handle(job);
    await generateProcessor.handle(job);
    expect(
      queued.filter((item) => item.name === "send-invoice-email"),
    ).toHaveLength(1);
    expect(notificationCalls).toHaveLength(0);
  });
});

describe("approved invoice recipient fence", () => {
  const approvedRecipients = {
    recipient: "approved@example.test",
    bcc: ["approved-bcc@example.test"],
    customerName: "Approved name",
    replyTo: "approved-reply@example.test",
  };
  test("generation preserves the exact approved recipient envelope in its durable email intent", async () => {
    invoice.status = "unpaid";
    await generateProcessor.handle(
      generateJob({
        invoiceId,
        deliveryType: "create_and_send",
        approvedRecipients,
      }),
    );
    expect(
      queued.find((item) => item.name === "send-invoice-email")?.payload,
    ).toMatchObject({ approvedRecipients });
  });
  test("later customer, billing-copy and reply-to changes cannot redirect an approved send", async () => {
    invoice.status = "unpaid";
    invoice.customer.email = "changed@example.test";
    invoice.customer.billingEmail = "changed-bcc@example.test";
    invoice.user = { email: "changed-author@example.test" };
    invoice.team.email = "changed-reply@example.test";
    const job = sendJob();
    job.data.approvedRecipients = approvedRecipients;
    await sendProcessor.handle(job);
    expect(notificationCalls).toHaveLength(1);
    expect(notificationCalls[0]!.payload).toMatchObject({
      customerEmail: "approved@example.test",
      customerName: "Approved name",
    });
    expect(notificationCalls[0]!.options).toMatchObject({
      bcc: ["approved-bcc@example.test"],
      replyTo: "approved-reply@example.test",
    });
    expect(JSON.stringify(notificationCalls)).not.toContain(
      "changed@example.test",
    );
    expect(JSON.stringify(notificationCalls)).not.toContain(
      "changed-bcc@example.test",
    );
    expect(JSON.stringify(notificationCalls)).not.toContain(
      "changed-author@example.test",
    );
    expect(writes[0]!.recipient).toBe("approved@example.test");
  });
});
