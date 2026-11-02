import { describe, expect, mock, test } from "bun:test";
import { InvoicePaymentError } from "@midday/db/errors";
import type { InvoicePaymentReservation } from "@midday/db/queries";
import type Stripe from "stripe";
import {
  type InvoicePaymentProvider,
  prepareInvoicePaymentSession,
} from "../services/invoice-payment-session";

const fixture: InvoicePaymentReservation = {
  id: "25e47cd2-703e-4738-8bee-881669c47aef",
  invoiceId: "73edc15c-7f58-42ca-9b25-ad0319f0bd10",
  teamId: "59468837-7f70-4257-b66c-7752d57591c1",
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

function createHarness(
  reservationOverrides: Partial<InvoicePaymentReservation> = {},
) {
  const reservation = { ...fixture, ...reservationOverrides };
  const intent = {
    id: "pi_fixture",
    status: "requires_payment_method" as Stripe.PaymentIntent.Status,
    amount: reservation.amountMinor,
    amount_received: 0,
    currency: reservation.currency,
    client_secret: "pi_fixture_secret_localfixture" as string | null,
    metadata: {
      invoice_id: reservation.invoiceId,
      invoice_number: reservation.invoiceNumber,
      team_id: reservation.teamId,
      payment_reservation_id: reservation.id,
    },
  };
  const repository = {
    reserve: mock(async () => reservation),
    attach: mock(
      async (_reservation: InvoicePaymentReservation, _id: string) => true,
    ),
    reconcile: mock(
      async (
        _reservation: InvoicePaymentReservation,
        _reason: string,
        _id?: string,
      ) => {},
    ),
  };
  const provider = {
    paymentIntents: {
      retrieve: mock(
        async (_id: string, _options: Stripe.RequestOptions) => intent,
      ),
      create: mock(
        async (
          _params: Stripe.PaymentIntentCreateParams,
          _options: Stripe.RequestOptions,
        ) => intent,
      ),
      cancel: mock(
        async (
          _id: string,
          _params: Stripe.PaymentIntentCancelParams,
          _options: Stripe.RequestOptions,
        ) => ({ ...intent, status: "canceled" as const }),
      ),
    },
  } satisfies InvoicePaymentProvider;
  return {
    repository,
    provider,
    reservation,
    intent,
    run: () => prepareInvoicePaymentSession(repository, provider),
  };
}

async function expectStatus(
  run: () => Promise<unknown>,
  status: InvoicePaymentError["status"],
) {
  try {
    await run();
    throw new Error("Payment unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(InvoicePaymentError);
    expect((error as InvoicePaymentError).status).toBe(status);
  }
}

describe("immutable invoice payment handoff (no real provider)", () => {
  test("reserves first, creates with immutable key/payload and discloses only after attachment", async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.repository.reserve.mockImplementation(async () => {
      calls.push("reserve");
      return h.reservation;
    });
    h.provider.paymentIntents.create.mockImplementation(async () => {
      calls.push("create");
      return h.intent;
    });
    h.provider.paymentIntents.retrieve.mockImplementation(async () => {
      calls.push("retrieve");
      return h.intent;
    });
    h.repository.attach.mockImplementation(async () => {
      calls.push("attach");
      return true;
    });
    expect(await h.run()).toEqual({
      clientSecret: "pi_fixture_secret_localfixture",
      amount: 12005,
      currency: "usd",
      stripeAccountId: "acct_fixture",
    });
    expect(calls).toEqual([
      "reserve",
      "create",
      "attach",
      "retrieve",
      "attach",
    ]);
    expect(h.provider.paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 12005,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: { ...h.intent.metadata },
      },
      {
        stripeAccount: "acct_fixture",
        idempotencyKey: `invoice-payment/${fixture.id}/v1`,
      },
    );
  });

  test("concurrent requests reuse the same durable provider key and identical body", async () => {
    const h = createHarness();
    const sessions = await Promise.all([h.run(), h.run()]);
    expect(sessions[0]).toEqual(sessions[1]);
    expect(h.provider.paymentIntents.create.mock.calls[0]).toEqual(
      h.provider.paymentIntents.create.mock.calls[1],
    );
  });

  for (const status of [400, 404, 409] as const) {
    test(`preserves reservation ${status} without calling the provider`, async () => {
      const h = createHarness();
      h.repository.reserve.mockImplementation(async () => {
        throw new InvoicePaymentError(status, "fixture rejection");
      });
      await expectStatus(h.run, status);
      expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
      expect(h.provider.paymentIntents.retrieve).not.toHaveBeenCalled();
    });
  }

  test("retries an unknown create outcome only with the same immutable key and payload", async () => {
    const h = createHarness();
    h.provider.paymentIntents.create.mockImplementationOnce(async () => {
      throw new Error("network timeout");
    });
    await expectStatus(h.run, 503);
    await h.run();
    expect(h.provider.paymentIntents.create.mock.calls[0]).toEqual(
      h.provider.paymentIntents.create.mock.calls[1],
    );
    expect(h.repository.reconcile).not.toHaveBeenCalled();
  });

  test("an idempotent create's old requires_payment_method response cannot hide current success", async () => {
    const h = createHarness();
    h.provider.paymentIntents.retrieve.mockImplementation(async () => ({
      ...h.intent,
      status: "succeeded",
    }));
    await expectStatus(h.run, 409);
    expect(h.provider.paymentIntents.retrieve).toHaveBeenCalledWith(
      "pi_fixture",
      { stripeAccount: "acct_fixture" },
    );
    expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test("a cancellation during the fresh provider read is caught by the final DB check", async () => {
    const h = createHarness();
    h.repository.attach.mockImplementationOnce(async () => true);
    h.repository.attach.mockImplementationOnce(async () => false);
    await expectStatus(h.run, 409);
    expect(h.provider.paymentIntents.retrieve).toHaveBeenCalledTimes(1);
    expect(h.repository.attach).toHaveBeenCalledTimes(2);
    expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test("provider status read failure retains a known intent without disclosing a secret", async () => {
    const h = createHarness();
    h.provider.paymentIntents.retrieve.mockImplementation(async () => {
      throw new Error("temporary read failure");
    });
    await expectStatus(h.run, 503);
    expect(h.repository.attach).toHaveBeenCalledWith(
      h.reservation,
      "pi_fixture",
    );
    expect(h.repository.reconcile).not.toHaveBeenCalled();
  });

  test("a reconciliation-required reservation never reaches the provider", async () => {
    const h = createHarness({ state: "reconciliation_required" });
    await expectStatus(h.run, 409);
    expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
    expect(h.provider.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  for (const error of [
    new Error("connection lost"),
    { statusCode: 429 },
    { statusCode: 500 },
    { statusCode: 401 },
  ]) {
    test(`never creates a replacement after retrieval failure ${JSON.stringify(error)}`, async () => {
      const h = createHarness({
        paymentIntentId: "pi_fixture",
        state: "attached",
      });
      h.provider.paymentIntents.retrieve.mockImplementation(async () => {
        throw error;
      });
      await expectStatus(h.run, 503);
      expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
      expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
    });
  }

  test("a confirmed missing legacy intent requires reconciliation, not replacement", async () => {
    const h = createHarness({
      paymentIntentId: "pi_fixture",
      state: "attached",
    });
    h.provider.paymentIntents.retrieve.mockImplementation(async () => {
      throw { statusCode: 404, code: "resource_missing" };
    });
    await expectStatus(h.run, 409);
    expect(h.repository.reconcile).toHaveBeenCalledWith(
      h.reservation,
      "provider_intent_missing",
    );
    expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
  });

  for (const status of [
    "processing",
    "requires_capture",
    "succeeded",
  ] as const) {
    test(`${status} does not return a payable client secret or cancel a legitimate payment`, async () => {
      const h = createHarness({
        paymentIntentId: "pi_fixture",
        state: "attached",
      });
      h.intent.status = status;
      await expectStatus(h.run, 409);
      expect(h.repository.attach).toHaveBeenCalled();
      expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
      expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
    });
  }

  for (const field of [
    "amount",
    "currency",
    "invoice",
    "team",
    "reservation",
    "id",
  ] as const) {
    test(`rejects a mismatched provider ${field} without exposing or mutating the intent`, async () => {
      const h = createHarness();
      if (field === "amount") h.intent.amount++;
      if (field === "currency") h.intent.currency = "eur";
      if (field === "invoice") h.intent.metadata.invoice_id = "another-invoice";
      if (field === "team") h.intent.metadata.team_id = "another-team";
      if (field === "reservation")
        h.intent.metadata.payment_reservation_id = "another-reservation";
      if (field === "id") h.intent.id = "not-a-payment-intent";
      await expectStatus(h.run, 409);
      expect(h.repository.reconcile).toHaveBeenCalled();
      expect(h.repository.attach).not.toHaveBeenCalled();
      expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
    });
  }

  test("never changes an existing in-flight intent to match changed invoice amount", async () => {
    const h = createHarness({
      paymentIntentId: "pi_fixture",
      state: "attached",
    });
    h.intent.amount = 1;
    h.intent.status = "processing";
    await expectStatus(h.run, 409);
    expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
    expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test("canceled intent is durable reconciliation, not a new checkout", async () => {
    const h = createHarness({
      paymentIntentId: "pi_fixture",
      state: "attached",
    });
    h.intent.status = "canceled";
    await expectStatus(h.run, 409);
    expect(h.repository.attach).not.toHaveBeenCalled();
    expect(h.repository.reconcile).toHaveBeenCalledWith(
      h.reservation,
      "provider_intent_canceled",
      "pi_fixture",
    );
    expect(h.provider.paymentIntents.create).not.toHaveBeenCalled();
  });

  test("a rejected attachment retains reconciliation without canceling a possibly disclosed intent", async () => {
    const h = createHarness();
    h.repository.attach.mockImplementation(async () => false);
    await expectStatus(h.run, 409);
    expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test("concurrent A success/B rejection cannot cancel the secret already disclosed to A", async () => {
    const h = createHarness();
    const bothCreated = Promise.withResolvers<void>();
    let creates = 0;
    h.provider.paymentIntents.create.mockImplementation(async () => {
      if (++creates === 2) bothCreated.resolve();
      await bothCreated.promise;
      return h.intent;
    });
    h.repository.attach.mockImplementationOnce(async () => true);
    h.repository.attach.mockImplementationOnce(async () => false);
    const outcomes = await Promise.allSettled([h.run(), h.run()]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(h.provider.paymentIntents.create.mock.calls[0]).toEqual(
      h.provider.paymentIntents.create.mock.calls[1],
    );
  });

  test("unknown DB commit outcome does not cancel an intent possibly disclosed by a concurrent request", async () => {
    const h = createHarness();
    h.repository.attach.mockImplementation(async () => {
      throw new Error("connection lost during commit");
    });
    await expectStatus(h.run, 503);
    expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test("a succeeded or processing stale create is never canceled", async () => {
    for (const status of [
      "succeeded",
      "processing",
      "requires_action",
    ] as const) {
      const h = createHarness();
      h.intent.status = status;
      h.repository.attach.mockImplementation(async () => false);
      await expectStatus(h.run, 409);
      expect(h.provider.paymentIntents.cancel).not.toHaveBeenCalled();
    }
  });

  for (const secret of [null, "", "pi_other_secret_fixture"]) {
    test(`invalid client-secret confirmation is not success (${secret})`, async () => {
      const h = createHarness();
      h.intent.client_secret = secret;
      await expectStatus(h.run, 409);
      expect(h.repository.reconcile).toHaveBeenCalledWith(
        h.reservation,
        "provider_response_invalid",
        "pi_fixture",
      );
    });
  }
});
