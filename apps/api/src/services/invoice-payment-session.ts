import { InvoicePaymentError } from "@midday/db/errors";
import type { InvoicePaymentReservation } from "@midday/db/queries";
import type Stripe from "stripe";

type PaymentIntent = Pick<
  Stripe.PaymentIntent,
  | "id"
  | "status"
  | "amount"
  | "amount_received"
  | "currency"
  | "client_secret"
  | "metadata"
>;

export type InvoicePaymentProvider = {
  paymentIntents: {
    retrieve(
      id: string,
      options: Stripe.RequestOptions,
    ): Promise<PaymentIntent>;
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<PaymentIntent>;
    cancel(
      id: string,
      params: Stripe.PaymentIntentCancelParams,
      options: Stripe.RequestOptions,
    ): Promise<PaymentIntent>;
  };
};

export type InvoicePaymentRepository = {
  reserve(): Promise<InvoicePaymentReservation>;
  attach(
    reservation: InvoicePaymentReservation,
    intentId: string,
  ): Promise<boolean>;
  reconcile(
    reservation: InvoicePaymentReservation,
    reason: string,
    intentId?: string,
  ): Promise<void>;
};

function knownMissingIntent(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404 &&
    "code" in error &&
    error.code === "resource_missing"
  );
}

function validIntentIdentity(
  intent: PaymentIntent,
  reservation: InvoicePaymentReservation,
) {
  return (
    typeof intent?.id === "string" &&
    /^pi_[A-Za-z0-9]+$/.test(intent.id) &&
    (!reservation.paymentIntentId ||
      reservation.paymentIntentId === intent.id) &&
    intent.amount === reservation.amountMinor &&
    intent.currency === reservation.currency &&
    intent.metadata?.invoice_id === reservation.invoiceId &&
    intent.metadata?.team_id === reservation.teamId &&
    // Legacy attached intents predate the reservation metadata. Never create a
    // replacement for one; exact invoice/account/amount checks still apply.
    (reservation.paymentIntentId ||
      intent.metadata?.payment_reservation_id === reservation.id)
  );
}

/**
 * Provider calls are deliberately outside the repository's short transactions.
 * Only this function returns the client secret, after conditional attachment.
 */
export async function prepareInvoicePaymentSession(
  repository: InvoicePaymentRepository,
  stripe: InvoicePaymentProvider,
) {
  const reservationStartedAt = performance.now();
  const reservation = await repository.reserve();
  // Keep the interval between the DB clock check and starting HTTP bounded.
  // The one-hour replay margin also exceeds the configured ten-second timeout.
  if (performance.now() - reservationStartedAt > 60_000) {
    throw new InvoicePaymentError(
      503,
      "Payment reservation timed out; retry the same invoice",
    );
  }
  if (reservation.state === "reconciliation_required") {
    throw new InvoicePaymentError(
      409,
      "Payment requires reconciliation before retrying",
    );
  }
  const options = { stripeAccount: reservation.stripeAccountId };
  let intent: PaymentIntent;

  try {
    intent = reservation.paymentIntentId
      ? await stripe.paymentIntents.retrieve(
          reservation.paymentIntentId,
          options,
        )
      : await stripe.paymentIntents.create(
          {
            amount: reservation.amountMinor,
            currency: reservation.currency,
            automatic_payment_methods: { enabled: true },
            metadata: {
              invoice_id: reservation.invoiceId,
              invoice_number: reservation.invoiceNumber,
              team_id: reservation.teamId,
              payment_reservation_id: reservation.id,
            },
          },
          {
            ...options,
            idempotencyKey: `invoice-payment/${reservation.id}/v1`,
          },
        );
  } catch (error) {
    if (reservation.paymentIntentId && knownMissingIntent(error)) {
      await repository.reconcile(reservation, "provider_intent_missing");
      throw new InvoicePaymentError(
        409,
        "Payment requires reconciliation before retrying",
      );
    }
    // No catch-all fallback to CREATE. For an unknown create outcome the same
    // persisted key/payload may be replayed only within the DB-enforced window.
    throw new InvoicePaymentError(
      503,
      "Payment provider is temporarily unavailable; retry this payment session",
    );
  }

  if (!validIntentIdentity(intent, reservation)) {
    await repository.reconcile(
      reservation,
      "provider_intent_mismatch",
      typeof intent?.id === "string" && /^pi_[A-Za-z0-9]+$/.test(intent.id)
        ? intent.id
        : undefined,
    );
    // A malformed response is not sufficient authority to cancel another ID.
    throw new InvoicePaymentError(
      409,
      "Payment details do not match the invoice; reconciliation is required",
    );
  }

  if (intent.status === "canceled") {
    await repository.reconcile(
      reservation,
      "provider_intent_canceled",
      intent.id,
    );
    throw new InvoicePaymentError(
      409,
      "This payment session was canceled; reconciliation is required",
    );
  }

  let attached: boolean;
  try {
    attached = await repository.attach(reservation, intent.id);
  } catch {
    // The commit outcome may be unknown. Do not cancel a possibly attached and
    // concurrently disclosed intent. Retry/reconcile the same durable attempt.
    throw new InvoicePaymentError(
      503,
      "Payment session confirmation is pending; retry the same invoice",
    );
  }
  if (!attached) {
    // Another request may already have attached and disclosed this exact
    // idempotent intent. A caller-local "created" flag is not proof otherwise.
    // Keep its known ID for reconciliation; never cancel or replace it here.
    throw new InvoicePaymentError(
      409,
      "Invoice changed during payment setup; reconciliation is required",
    );
  }

  if (!reservation.paymentIntentId) {
    // Stripe v1 replays the ORIGINAL create response. Its status/client_secret
    // is not a fresh read: another caller may already have paid the same intent.
    // The ID is now durable, so a failed read retries GET, never a new CREATE.
    try {
      const current = await stripe.paymentIntents.retrieve(intent.id, options);
      if (
        !validIntentIdentity(current, {
          ...reservation,
          paymentIntentId: intent.id,
        })
      ) {
        await repository.reconcile(
          reservation,
          "provider_intent_mismatch",
          intent.id,
        );
        throw new InvoicePaymentError(
          409,
          "Payment details require reconciliation",
        );
      }
      intent = current;
    } catch (error) {
      if (error instanceof InvoicePaymentError) throw error;
      if (knownMissingIntent(error)) {
        await repository.reconcile(
          reservation,
          "provider_intent_missing",
          intent.id,
        );
        throw new InvoicePaymentError(
          409,
          "Payment requires reconciliation before retrying",
        );
      }
      throw new InvoicePaymentError(
        503,
        "Payment status confirmation is pending; retry the same invoice",
      );
    }
  }

  if (intent.status === "canceled") {
    await repository.reconcile(
      reservation,
      "provider_intent_canceled",
      intent.id,
    );
    throw new InvoicePaymentError(
      409,
      "This payment session was canceled; reconciliation is required",
    );
  }

  if (intent.status === "succeeded") {
    throw new InvoicePaymentError(
      409,
      "Payment already succeeded; invoice confirmation is pending",
    );
  }
  if (intent.status === "processing" || intent.status === "requires_capture") {
    throw new InvoicePaymentError(
      409,
      "Payment is already in progress; do not submit another payment",
    );
  }
  if (
    ![
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
    ].includes(intent.status) ||
    typeof intent.client_secret !== "string" ||
    !intent.client_secret.startsWith(`${intent.id}_secret_`) ||
    intent.client_secret.length <= `${intent.id}_secret_`.length
  ) {
    await repository.reconcile(
      reservation,
      "provider_response_invalid",
      intent.id,
    );
    throw new InvoicePaymentError(
      409,
      "Payment response requires reconciliation",
    );
  }

  // The fresh GET above was another external interval. Recheck current invoice
  // state after it before disclosing anything to the customer.
  if (!reservation.paymentIntentId) {
    try {
      if (!(await repository.attach(reservation, intent.id))) {
        throw new InvoicePaymentError(
          409,
          "Invoice changed during payment setup; reconciliation is required",
        );
      }
    } catch (error) {
      if (error instanceof InvoicePaymentError) throw error;
      throw new InvoicePaymentError(
        503,
        "Payment session confirmation is pending; retry the same invoice",
      );
    }
  }

  return {
    clientSecret: intent.client_secret,
    amount: intent.amount,
    currency: intent.currency,
    stripeAccountId: reservation.stripeAccountId,
  };
}
