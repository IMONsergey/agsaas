import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  type BillingProduct,
  BillingSubscriptionEventError,
  parseBillingSubscriptionEvent,
} from "../billing-subscription";
import type { DatabaseOrTransaction } from "../client";
import { teams, users, usersOnTeam } from "../schema";
import {
  ensureNotificationDispatch,
  notificationDispatchOperationKey,
} from "./notification-dispatches";

/** The caller must supply an SDK-verified event, never a raw request body.
 * Own products and the immutable customer external ID bind it to one team. */
export async function applyBillingSubscriptionEvent(
  db: DatabaseOrTransaction,
  input: {
    event: unknown;
    products: readonly BillingProduct[];
    expectedBinding?: { teamId: string; subscriptionId: string };
  },
) {
  const event = parseBillingSubscriptionEvent(input.event, input.products);
  if (!event) return { state: "unsupported" as const };
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  return primary.transaction(async (tx) => {
    const [team] = await tx
      .select({
        id: teams.id,
        name: teams.name,
        plan: teams.plan,
        canceledAt: teams.canceledAt,
        subscriptionStatus: teams.subscriptionStatus,
        billingSubscriptionId: teams.billingSubscriptionId,
        billingSubscriptionCreatedAt: teams.billingSubscriptionCreatedAt,
        billingUpdatedAt: teams.billingUpdatedAt,
      })
      .from(teams)
      .where(eq(teams.id, event.teamId))
      .for("update");
    if (!team) return { state: "missing" as const };
    if (
      input.expectedBinding &&
      (input.expectedBinding.teamId !== team.id ||
        input.expectedBinding.subscriptionId !== team.billingSubscriptionId ||
        event.subscriptionId !== input.expectedBinding.subscriptionId)
    )
      return { state: "foreign_subscription" as const };

    if (
      (team.billingSubscriptionId === null) !==
        (team.billingUpdatedAt === null) ||
      (team.billingSubscriptionId === null) !==
        (team.billingSubscriptionCreatedAt === null) ||
      (team.billingUpdatedAt !== null &&
        !Number.isFinite(Date.parse(team.billingUpdatedAt))) ||
      (team.billingSubscriptionCreatedAt !== null &&
        !Number.isFinite(Date.parse(team.billingSubscriptionCreatedAt)))
    ) {
      throw new Error("Billing subscription version requires reconciliation");
    }
    const sameSubscription =
      team.billingSubscriptionId === event.subscriptionId;
    const establishesSubscription =
      event.action === "active" || event.action === "trialing";
    if (!establishesSubscription && !sameSubscription) {
      // An old subscription's later cancellation must not advance the clock
      // or change the plan of its replacement. Unbound legacy rows also stop.
      return { state: "foreign_subscription" as const };
    }
    if (sameSubscription) {
      if (
        Date.parse(event.createdAt) !==
        Date.parse(team.billingSubscriptionCreatedAt!)
      ) {
        throw new BillingSubscriptionEventError();
      }
      if (Date.parse(event.modifiedAt) <= Date.parse(team.billingUpdatedAt!)) {
        return { state: "stale" as const };
      }
    } else if (team.billingSubscriptionCreatedAt !== null) {
      // modifiedAt orders versions of one resource, not the age of different
      // subscriptions. A recovered older subscription cannot replace a new one.
      const ageDifference =
        Date.parse(event.createdAt) -
        Date.parse(team.billingSubscriptionCreatedAt);
      if (ageDifference === 0)
        return { state: "ambiguous_subscription" as const };
      if (ageDifference < 0) return { state: "stale" as const };
    }

    const update: Partial<typeof teams.$inferInsert> = {
      billingSubscriptionId: event.subscriptionId,
      billingSubscriptionCreatedAt: event.createdAt,
      billingUpdatedAt: event.modifiedAt,
      // Event names can share one resource version. Apply its complete
      // entitlement state so active/canceled delivery order is immaterial.
      plan: event.action === "revoked" ? "trial" : event.plan,
      subscriptionStatus: event.subscriptionStatus,
      canceledAt:
        event.action === "revoked"
          ? event.modifiedAt
          : event.cancelAtPeriodEnd
            ? ((sameSubscription ? team.canceledAt : null) ?? event.modifiedAt)
            : null,
    };
    if (event.email !== undefined) update.email = event.email;
    // Keep identity, age and version after revocation as a stale-event tombstone.
    await tx.update(teams).set(update).where(eq(teams.id, event.teamId));

    // The resource may first arrive as a scheduled-cancellation snapshot with
    // past_due status. Retain its notice on that transition too, so a second
    // same-version past_due delivery cannot become a no-op without an intent.
    const paymentIssue =
      event.subscriptionStatus === "past_due" &&
      team.subscriptionStatus !== "past_due";
    if (paymentIssue) {
      // Same primary transaction and team lock as the entitlement transition.
      // Never use an unscoped webhook email or a replica for this recipient.
      const [owner] = await tx
        .select({ email: users.email, fullName: users.fullName })
        .from(usersOnTeam)
        .innerJoin(users, eq(users.id, usersOnTeam.userId))
        .where(
          and(
            eq(usersOnTeam.teamId, event.teamId),
            eq(usersOnTeam.role, "owner"),
            isNull(users.deletionStartedAt),
            sql`length(btrim(${users.email})) > 0`,
          ),
        )
        .orderBy(asc(users.id))
        .limit(1);
      if (!owner?.email)
        throw new Error("Billing notice recipient is unavailable");
      const operation = createHash("sha256")
        .update(`${event.subscriptionId}\0${event.modifiedAt}`)
        .digest("hex");
      const sourceJobId = `payment-issue-${event.teamId}-${operation}`;
      try {
        await ensureNotificationDispatch(tx, {
          teamId: event.teamId,
          operationKey: notificationDispatchOperationKey(
            "payment-issue",
            sourceJobId,
          ),
          kind: "payment-issue",
          sourceJobId,
          payload: {
            teamId: event.teamId,
            email: owner.email.trim(),
            fullName: owner.fullName?.trim() || "there",
            teamName: team.name || "AGSaaS",
          },
        });
      } catch {
        // Drizzle errors may include bound recipient parameters. Preserve the
        // rollback/retry signal without copying the payload into webhook logs.
        throw new Error("Billing notification intent could not be retained");
      }
    }
    return { state: "applied" as const, ...event };
  });
}

/** Read-only primary binding for provider reconciliation; absence never triggers provider discovery by email. */
export async function getBillingSubscriptionBinding(
  db: DatabaseOrTransaction,
  teamId: string,
) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  const [row] = await primary
    .select({ teamId: teams.id, subscriptionId: teams.billingSubscriptionId })
    .from(teams)
    .where(eq(teams.id, teamId));
  return row?.subscriptionId
    ? { teamId: row.teamId, subscriptionId: row.subscriptionId }
    : null;
}
