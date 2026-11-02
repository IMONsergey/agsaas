import type { Database } from "@midday/db/client";
import type { NotificationDispatchKind } from "@midday/db/notification-dispatch";
import {
  beginNotificationDispatch,
  ensureNotificationDispatch,
  finishNotificationDispatch,
  interruptNotificationDispatch,
  notificationDispatchOperationKey,
  stopPendingNotificationDispatch,
} from "@midday/db/queries/notification-dispatches";
import {
  getProductEmailConfig,
  isProductEmailTransportAvailable,
} from "@midday/email/config";
import type { NotificationResult } from "@midday/notifications";
import { NonRetryableError } from "./error-classification";

export class NotificationDispatchPendingError extends Error {
  constructor(readonly dispatchId: string) {
    super(`Notification email deferred; recovery owns dispatch ${dispatchId}`);
    this.name = "NotificationDispatchPendingError";
  }
}

export type NotificationDispatchResult = {
  dispatchId: string;
  status: "completed";
  reused: boolean;
  /** Provider acceptance counts, not mailbox delivery. */
  accepted: number;
  skipped: number;
};

/** Generic mail has no immutable provider envelope. Once a dispatch may have
 * reached the provider, only an explicit zero-acceptance rejection can retry.
 * In-app activity uses a separate deterministic identity before this fence. */
export async function dispatchNotificationEmail(input: {
  db: Database;
  kind: NotificationDispatchKind;
  sourceJobId: string;
  payload: Record<string, unknown> & { teamId: string };
  createActivities?: (operationKey: string) => Promise<number>;
  isCurrent?: () => Promise<boolean>;
  send: () => Promise<NotificationResult>;
}): Promise<NotificationDispatchResult> {
  const operationKey = notificationDispatchOperationKey(
    input.kind,
    input.sourceJobId,
  );
  const scope = { teamId: input.payload.teamId, operationKey };
  let existing: Awaited<ReturnType<typeof ensureNotificationDispatch>>;
  try {
    existing = await ensureNotificationDispatch(input.db, {
      ...scope,
      kind: input.kind,
      sourceJobId: input.sourceJobId,
      payload: input.payload,
    });
  } catch {
    // A database error can contain bound recipient/payload parameters.
    throw new Error(
      "Notification intent could not be persisted; no email dispatched",
    );
  }
  const completed = (
    row: typeof existing,
    reused: boolean,
  ): NotificationDispatchResult => ({
    dispatchId: row.id,
    status: "completed",
    reused,
    accepted: row.outcome?.sent ?? 0,
    skipped: row.outcome?.skipped ?? 0,
  });
  const stopped = (status: string): never => {
    throw new NonRetryableError(
      `Notification email ${status}; review dispatch ${existing.id}`,
    );
  };
  if (existing.status === "completed") return completed(existing, true);
  if (existing.status === "rejected" || existing.status === "reconciliation")
    return stopped(existing.status);
  if (existing.status === "dispatching") {
    let previous: Awaited<ReturnType<typeof beginNotificationDispatch>>;
    try {
      previous = await beginNotificationDispatch(input.db, scope, false);
    } catch {
      throw new NotificationDispatchPendingError(existing.id);
    }
    if (previous.state === "completed" && previous.row)
      return completed(previous.row, true);
    if (previous.state === "busy" || previous.state === "pending")
      throw new NotificationDispatchPendingError(existing.id);
    return stopped(previous.state);
  }

  if (input.isCurrent) {
    let current: boolean;
    try {
      current = await input.isCurrent();
    } catch {
      throw new NotificationDispatchPendingError(existing.id);
    }
    if (!current) {
      try {
        await stopPendingNotificationDispatch(input.db, scope);
      } catch {
        throw new NotificationDispatchPendingError(existing.id);
      }
      return stopped("event_expired");
    }
  }

  // Product events must remain visible in-app while email is unconfigured.
  // A repeat of this phase must use activityOperationKey, never an append.
  let activityCount: number;
  try {
    activityCount = (await input.createActivities?.(operationKey)) ?? 0;
  } catch {
    throw new NotificationDispatchPendingError(existing.id);
  }
  let ready = isProductEmailTransportAvailable();
  if (ready) {
    try {
      getProductEmailConfig();
    } catch {
      ready = false;
    }
  }
  let claim: Awaited<ReturnType<typeof beginNotificationDispatch>>;
  try {
    claim = await beginNotificationDispatch(input.db, scope, ready);
  } catch {
    throw new NotificationDispatchPendingError(existing.id);
  }
  if (claim.state === "completed" && claim.row)
    return completed(claim.row, true);
  if (claim.state === "pending" || claim.state === "busy")
    throw new NotificationDispatchPendingError(existing.id);
  if (claim.state !== "claimed") return stopped(claim.state);

  const fence = { ...scope, token: claim.token };
  let result: NotificationResult;
  try {
    result = await input.send();
  } catch {
    // An exception cannot prove that no recipient was accepted. Persist the
    // stop when possible; recovery also stops an expired fence after a crash.
    try {
      await interruptNotificationDispatch(input.db, fence);
    } catch {
      /* The existing fence still prevents a new send. */
    }
    return stopped("reconciliation");
  }
  let finished: Awaited<ReturnType<typeof finishNotificationDispatch>>;
  try {
    finished = await finishNotificationDispatch(input.db, fence, {
      activities: activityCount,
      sent: result.emails.sent,
      skipped: result.emails.skipped,
      failed: result.emails.failed,
      uncertain: result.emails.uncertain,
      retryable: result.emails.retryable,
      providerMessageIds: result.emails.providerMessageIds,
      ...(result.emails.reason ? { reason: result.emails.reason } : {}),
    });
  } catch {
    // Never replay an acknowledged external request to repair a DB write.
    return stopped("receipt_reconciliation");
  }
  if (finished?.status === "completed") return completed(finished, false);
  if (finished?.status === "pending")
    throw new NotificationDispatchPendingError(existing.id);
  return stopped(finished?.status ?? "reconciliation");
}
