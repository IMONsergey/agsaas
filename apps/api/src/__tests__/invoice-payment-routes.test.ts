import { beforeEach, describe, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { InvoicePaymentError } from "@midday/db/errors";
import type {
  InvoicePaymentReservation,
  StripeInvoicePaymentEvent,
} from "@midday/db/queries";
import type Stripe from "stripe";
import type { Context } from "../rest/types";

// Run in its own process: provider signature/HTTP and DB seams are isolated
// mocks, never live Stripe requests or a server database.
const invoiceId = "73edc15c-7f58-42ca-9b25-ad0319f0bd10";
const teamId = "59468837-7f70-4257-b66c-7752d57591c1";
const reservation: InvoicePaymentReservation = {
  id: "25e47cd2-703e-4738-8bee-881669c47aef",
  invoiceId,
  teamId,
  stripeAccountId: "acct_fixture",
  amountMinor: 12005,
  currency: "usd",
  invoiceNumber: "INV-001",
  paymentIntentId: null,
  state: "reserved",
  failureCode: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastAttemptAt: "2026-11-01T00:00:00.000Z",
};
const providerIntent = {
  id: "pi_fixture",
  amount: 12005,
  amount_received: 0,
  currency: "usd",
  status: "requires_payment_method",
  client_secret: "pi_fixture_secret_localfixture",
  metadata: {
    invoice_id: invoiceId,
    team_id: teamId,
    invoice_number: "INV-001",
    payment_reservation_id: reservation.id,
  } as Stripe.Metadata,
};
const invoice = {
  id: invoiceId,
  teamId,
  invoiceNumber: "INV-001",
  customerName: "Fixture",
  paidAt: null,
  refundedAt: null,
};

const reserve = mock(async () => ({ ...reservation }));
const attach = mock(async () => true);
const reconcile = mock(async () => {});
const applyEvent = mock(
  async (_db: unknown, _event: StripeInvoicePaymentEvent) => ({
    invoice,
    notify: true,
  }),
);
const create = mock(async () => ({ ...providerIntent }));
const retrieve = mock(async () => ({ ...providerIntent }));
const cancel = mock(async () => ({ ...providerIntent, status: "canceled" }));
const listRefunds = mock(async () => ({
  data: [
    {
      id: "re_fixture",
      status: "succeeded",
      amount: 12005,
      currency: "usd",
      payment_intent: "pi_fixture",
    },
  ],
  has_more: false,
}));
const verifyToken = mock(async () => ({ id: invoiceId }));
const queue = mock(
  async (
    _name: string,
    _payload: unknown,
    _queue: string,
    _options: { jobId: string },
  ) => ({ id: "notifications_fixture" }),
);
let event: {
  id: string;
  type: Stripe.Event.Type;
  created: number;
  account?: string;
  data: { object: Record<string, unknown> };
};
const constructEvent = mock(async () => event);

mock.module("@api/rest/middleware", () => ({
  publicMiddleware: [],
  protectedMiddleware: [],
}));
mock.module("@midday/encryption", () => ({
  decryptOAuthState: () => null,
  encryptOAuthState: () => "fixture",
}));
mock.module("@midday/invoice/token", () => ({ verify: verifyToken }));
mock.module("@midday/db/queries", () => ({
  reserveInvoicePayment: reserve,
  attachInvoicePayment: attach,
  requireInvoicePaymentReconciliation: reconcile,
  applyStripeInvoicePaymentEvent: applyEvent,
  getTeamById: async () => null,
  updateTeamById: async () => null,
  getTeamByStripeAccountId: async () => null,
}));
mock.module("@midday/job-client", () => ({ triggerJob: queue }));
mock.module("@midday/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module("stripe", () => ({
  default: class {
    paymentIntents = { create, retrieve, cancel };
    refunds = { list: listRefunds };
    webhooks = { constructEventAsync: constructEvent };
  },
}));

const { invoicePaymentsRouter } = await import(
  "../rest/routers/invoice-payments"
);
const { stripeWebhookRouter } = await import("../rest/routers/webhooks/stripe");
const app = new OpenAPIHono<Context>();
app.use("*", async (c, next) => {
  c.set("db", {} as Context["Variables"]["db"]);
  await next();
});
app.route("/invoice-payments", invoicePaymentsRouter);
app.route("/stripe", stripeWebhookRouter);

beforeEach(() => {
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_local_fixture_only";
  for (const fn of [
    reserve,
    attach,
    reconcile,
    applyEvent,
    create,
    retrieve,
    cancel,
    listRefunds,
    verifyToken,
    queue,
    constructEvent,
  ])
    fn.mockClear();
  reserve.mockImplementation(async () => ({ ...reservation }));
  attach.mockImplementation(async () => true);
  reconcile.mockImplementation(async () => {});
  applyEvent.mockImplementation(async () => ({ invoice, notify: true }));
  create.mockImplementation(async () => ({ ...providerIntent }));
  retrieve.mockImplementation(async () => ({ ...providerIntent }));
  listRefunds.mockImplementation(async () => ({
    data: [
      {
        id: "re_fixture",
        status: "succeeded",
        amount: 12005,
        currency: "usd",
        payment_intent: "pi_fixture",
      },
    ],
    has_more: false,
  }));
  verifyToken.mockImplementation(async () => ({ id: invoiceId }));
  queue.mockImplementation(async () => ({ id: "notifications_fixture" }));
  constructEvent.mockImplementation(async () => event);
  event = {
    id: "evt_fixture",
    type: "payment_intent.succeeded",
    created: 1793491200,
    account: "acct_fixture",
    data: {
      object: {
        ...providerIntent,
        status: "succeeded",
        amount_received: 12005,
      },
    },
  };
});

function checkout() {
  return app.request("/invoice-payments/payment-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "fixture-token" }),
  });
}
function webhook(signature = "fixture-signature") {
  return app.request("/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: "signed fixture body",
  });
}

describe("invoice payment route responses", () => {
  test("returns session only after reserving and binding the intent", async () => {
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientSecret: providerIntent.client_secret,
      amount: 12005,
      currency: "usd",
      stripeAccountId: "acct_fixture",
    });
    expect(reserve).toHaveBeenCalledWith(expect.anything(), { invoiceId });
    expect(attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: reservation.id,
        invoiceId,
        teamId,
        paymentIntentId: "pi_fixture",
      }),
    );
  });
  for (const status of [400, 404, 409, 503] as const) {
    test(`preserves ${status}, does not hide it behind a false generic 500`, async () => {
      reserve.mockImplementation(async () => {
        throw new InvoicePaymentError(status, "fixture rejection");
      });
      const res = await checkout();
      expect(res.status).toBe(status);
      expect(create).not.toHaveBeenCalled();
    });
  }
  test("malformed verified token ID never reaches the database", async () => {
    verifyToken.mockImplementation(async () => ({ id: "not-a-uuid" }));
    expect((await checkout()).status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });
  test("rejected attachment is a conflict with no client secret and no cancellation", async () => {
    attach.mockImplementation(async () => false);
    const res = await checkout();
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain(providerIntent.client_secret);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("Stripe webhook boundary", () => {
  test("valid paid event includes original account, intent, money and reservation binding", async () => {
    expect((await webhook()).status).toBe(200);
    expect(applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        invoiceId,
        teamId,
        paymentIntentId: "pi_fixture",
        stripeAccountId: "acct_fixture",
        amountMinor: 12005,
        currency: "usd",
        reservationId: reservation.id,
        kind: "paid",
      }),
    );
    expect(queue).toHaveBeenCalledWith(
      "notification",
      expect.objectContaining({ type: "invoice_paid", invoiceId }),
      "notifications",
      { jobId: "stripe-event-evt_fixture" },
    );
  });
  test("invalid signature is rejected before any financial operation", async () => {
    constructEvent.mockImplementation(async () => {
      throw new Error("signature invalid");
    });
    expect((await webhook()).status).toBe(400);
    expect(applyEvent).not.toHaveBeenCalled();
  });
  test("database processing failure is not acknowledged as success", async () => {
    applyEvent.mockImplementation(async () => {
      throw new Error("DB unavailable");
    });
    expect((await webhook()).status).toBe(500);
    expect(queue).not.toHaveBeenCalled();
  });
  test("Redis failure remains retryable after a successful database write", async () => {
    queue.mockImplementation(async () => {
      throw new Error("Redis unavailable");
    });
    expect((await webhook()).status).toBe(500);
    queue.mockImplementation(async () => ({ id: "notifications_fixture" }));
    expect((await webhook()).status).toBe(200);
    expect(queue.mock.calls[0]?.[3]).toEqual(queue.mock.calls[1]?.[3]);
  });
  test("late paid event after refund does not enqueue an obsolete notification", async () => {
    applyEvent.mockImplementation(async () => ({ invoice, notify: false }));
    expect((await webhook()).status).toBe(200);
    expect(queue).not.toHaveBeenCalled();
  });
  test("missing account or short payment cannot be marked fully paid", async () => {
    event.account = undefined;
    expect((await webhook()).status).toBe(500);
    event.account = "acct_fixture";
    event.data.object.amount_received = 12004;
    expect((await webhook()).status).toBe(500);
    expect(applyEvent).not.toHaveBeenCalled();
  });
  test("partial charge refund forwards exact evidence without claiming a full refund", async () => {
    applyEvent.mockImplementation(async () => ({ invoice, notify: false }));
    event.type = "charge.refunded";
    event.data.object = {
      id: "ch_fixture",
      payment_intent: "pi_fixture",
      amount: 12005,
      amount_refunded: 1000,
      refunded: false,
      paid: true,
      currency: "usd",
    };
    retrieve.mockImplementation(async () => ({
      ...providerIntent,
      status: "succeeded",
      amount_received: 12005,
    }));
    listRefunds.mockImplementation(async () => ({
      data: [
        {
          id: "re_fixture",
          status: "succeeded",
          amount: 1000,
          currency: "usd",
          payment_intent: "pi_fixture",
        },
      ],
      has_more: false,
    }));
    expect((await webhook()).status).toBe(200);
    expect(applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountMinor: 12005,
        refunds: [{ id: "re_fixture", amountMinor: 1000, status: "succeeded" }],
      }),
    );
    expect(queue).not.toHaveBeenCalled();
  });
  test("full refund accepts expanded intent IDs and applies verified binding", async () => {
    event.type = "charge.refunded";
    event.data.object = {
      id: "ch_fixture",
      payment_intent: { id: "pi_fixture" },
      amount: 12005,
      amount_refunded: 12005,
      refunded: true,
      paid: true,
      currency: "usd",
    };
    retrieve.mockImplementation(async () => ({
      ...providerIntent,
      status: "succeeded",
      amount_received: 12005,
    }));
    expect((await webhook()).status).toBe(200);
    expect(applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentIntentId: "pi_fixture",
        stripeAccountId: "acct_fixture",
        kind: "refunded",
        amountMinor: 12005,
        currency: "usd",
      }),
    );
    expect(queue.mock.calls[0]?.[3]).toEqual({
      jobId: "stripe-invoice-refunded-pi_fixture",
    });
  });
  test("a pending refund forwards evidence but does not prematurely finalize", async () => {
    applyEvent.mockImplementation(async () => ({ invoice, notify: false }));
    event.type = "charge.refunded";
    event.data.object = {
      id: "ch_fixture",
      payment_intent: "pi_fixture",
      amount: 12005,
      amount_refunded: 12005,
      refunded: true,
      paid: true,
      currency: "usd",
    };
    retrieve.mockImplementation(async () => ({
      ...providerIntent,
      status: "succeeded",
      amount_received: 12005,
    }));
    listRefunds.mockImplementation(async () => ({
      data: [
        {
          id: "re_fixture",
          status: "pending",
          amount: 12005,
          currency: "usd",
          payment_intent: "pi_fixture",
        },
      ],
      has_more: false,
    }));
    expect((await webhook()).status).toBe(200);
    expect(applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        refunds: [{ id: "re_fixture", amountMinor: 12005, status: "pending" }],
      }),
    );
    expect(queue).not.toHaveBeenCalled();
  });
  test("later refund.updated confirms full success without needing another charge event", async () => {
    event.type = "refund.updated";
    event.data.object = {
      id: "re_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
    };
    retrieve.mockImplementation(async () => ({
      ...providerIntent,
      status: "succeeded",
      amount_received: 12005,
    }));
    expect((await webhook()).status).toBe(200);
    expect(applyEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "refunded", amountMinor: 12005 }),
    );
    expect(queue.mock.calls[0]?.[3]).toEqual({
      jobId: "stripe-invoice-refunded-pi_fixture",
    });
  });
  test("a pre-attachment full refund forwards the fresh intent's exact reservation candidate, not refund-object metadata", async () => {
    event.type = "refund.updated";
    event.data.object = {
      id: "re_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
      metadata: {
        invoice_id: "e2bef1bd-5609-42c2-9176-0c055cf0e288",
        team_id: "6955a297-e80b-41c0-bc31-e5c41955fadd",
        payment_reservation_id: "56df60ae-826b-4ce3-a946-cb4c3a7eb6b1",
      },
    };
    retrieve.mockImplementation(async () => ({
      ...providerIntent,
      status: "succeeded",
      amount_received: 12005,
    }));
    expect((await webhook()).status).toBe(200);
    expect(applyEvent.mock.calls[0]?.[1]).toEqual({
      invoiceId,
      teamId,
      reservationId: reservation.id,
      paymentIntentId: "pi_fixture",
      stripeAccountId: "acct_fixture",
      amountMinor: 12005,
      currency: "usd",
      kind: "refunded",
      refunds: [{ id: "re_fixture", amountMinor: 12005, status: "succeeded" }],
      occurredAt: new Date(event.created * 1000).toISOString(),
    });
  });
  for (const metadata of [
    {},
    { invoice_id: invoiceId, team_id: teamId },
    { ...providerIntent.metadata, invoice_id: "invalid" },
    { ...providerIntent.metadata, team_id: "invalid" },
    { ...providerIntent.metadata, payment_reservation_id: "invalid" },
  ] as Stripe.Metadata[]) {
    test(`missing/invalid legacy refund identity only permits attached-intent lookup: ${JSON.stringify(metadata)}`, async () => {
      event.type = "refund.updated";
      event.data.object = {
        id: "re_fixture",
        payment_intent: "pi_fixture",
        status: "succeeded",
        metadata: providerIntent.metadata,
      };
      retrieve.mockImplementation(async () => ({
        ...providerIntent,
        status: "succeeded",
        amount_received: 12005,
        metadata,
      }));
      expect((await webhook()).status).toBe(200);
      expect(applyEvent.mock.calls[0]?.[1]).toEqual({
        paymentIntentId: "pi_fixture",
        stripeAccountId: "acct_fixture",
        amountMinor: 12005,
        currency: "usd",
        kind: "refunded",
        refunds: [
          { id: "re_fixture", amountMinor: 12005, status: "succeeded" },
        ],
        occurredAt: new Date(event.created * 1000).toISOString(),
      });
    });
  }
  test("a valid-shaped refund candidate still needs DB authorization and cannot enqueue on a rejected binding", async () => {
    event.type = "refund.updated";
    event.account = "acct_attacker";
    event.data.object = {
      id: "re_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
    };
    retrieve.mockImplementation(async () => ({
      ...providerIntent,
      status: "succeeded",
      amount_received: 12005,
    }));
    applyEvent.mockImplementation(async () => {
      throw new InvoicePaymentError(
        409,
        "Payment event requires reconciliation",
      );
    });
    expect((await webhook()).status).toBe(500);
    expect(applyEvent.mock.calls[0]?.[1]).toMatchObject({
      invoiceId,
      teamId,
      reservationId: reservation.id,
      stripeAccountId: "acct_attacker",
    });
    expect(queue).not.toHaveBeenCalled();
  });
  test("refund provider uncertainty is retryable and never acknowledged as financial completion", async () => {
    event.type = "refund.updated";
    event.data.object = {
      id: "re_fixture",
      payment_intent: "pi_fixture",
      status: "succeeded",
    };
    retrieve.mockImplementation(async () => {
      throw new Error("pi_fixture_secret_private");
    });
    const response = await webhook();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret_private");
    expect(applyEvent).not.toHaveBeenCalled();
  });
});
