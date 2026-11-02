import {
  assertEmailAccepted,
  EmailDeliveryError,
  type EmailDeliveryResult,
  isEmailAccepted,
  type NotificationResult,
} from "@midday/notifications";
import { NonRetryableError } from "../../utils/error-classification";

/**
 * An HTTP acknowledgement and a local database write cannot be committed
 * atomically. Do not turn an ambiguous outcome or a post-acceptance local error
 * into an automatic resend. These failed jobs need provider reconciliation.
 * This is deliberately not an exactly-once guarantee: a process can still die
 * after provider acceptance and before recording it (a durable outbox is needed
 * to close that recovery gap).
 */
export async function deliverInvoiceEmail(
  send: () => Promise<NotificationResult>,
  recordAcceptance: (acceptedAt: string) => Promise<unknown>,
): Promise<EmailDeliveryResult> {
  let delivery: EmailDeliveryResult;
  let activityFailure: EmailDeliveryError | undefined;
  try {
    const result = await send();
    delivery = result.emails;
    assertEmailAccepted(delivery);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "InvoiceDeliveryStoppedError"
    ) {
      throw new NonRetryableError(error.message, error);
    }
    if (
      error instanceof EmailDeliveryError &&
      error.phase === "activity" &&
      isEmailAccepted(error.result)
    ) {
      // Preserve the known acceptance even if the later activity write failed.
      delivery = error.result;
      activityFailure = error;
    } else if (error instanceof EmailDeliveryError && !error.retryable) {
      throw new NonRetryableError(error.message, error);
    } else {
      // A confirmed transient rejection, or a failure before the email service
      // was invoked, can safely follow the normal retry classification.
      throw error;
    }
  }

  const acceptedAt = delivery.acceptedAt ?? new Date().toISOString();
  // The durable invoice path committed receipt + invoice + activities together.
  if (delivery.recorded) return delivery;
  try {
    const updated = await recordAcceptance(acceptedAt);
    if (!updated)
      throw new Error("Invoice disappeared before acceptance write");
  } catch (error) {
    throw new NonRetryableError(
      "Email accepted but invoice acceptance could not be recorded; reconciliation required, do not automatically resend",
      error,
    );
  }

  if (activityFailure) {
    throw new NonRetryableError(
      "Email acceptance recorded but notification activity failed; reconciliation required, do not automatically resend",
      activityFailure,
    );
  }
  return delivery;
}
