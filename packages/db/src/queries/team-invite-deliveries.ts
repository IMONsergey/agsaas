import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseOrTransaction, TransactionClient } from "../client";
import {
  teamInviteDeliveries,
  teams,
  userInvites,
  users,
  usersOnTeam,
} from "../schema";
import {
  TEAM_INVITE_LEASE_SECONDS,
  TEAM_INVITE_MAX_ATTEMPTS,
  TEAM_INVITE_REPLAY_WINDOW_MS,
  type TeamInviteDeliveryScope,
  teamInviteEnvelopeHash,
  validateTeamInviteEnvelope,
} from "../team-invite-delivery";
import { invoiceEmailClockIsUnsafe } from "./invoice-email-deliveries";

export type { TeamInviteDeliveryScope } from "../team-invite-delivery";
export type TeamInviteDelivery = typeof teamInviteDeliveries.$inferSelect;
export type TeamInviteDeliveryOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "retry" | "rejected" | "reconciliation"; code: string };

const scopeWhere = (scope: TeamInviteDeliveryScope) =>
  and(
    eq(teamInviteDeliveries.id, scope.deliveryId),
    eq(teamInviteDeliveries.inviteId, scope.inviteId),
    eq(teamInviteDeliveries.teamId, scope.teamId),
  );

export async function getTeamInviteDelivery(
  db: DatabaseOrTransaction,
  scope: TeamInviteDeliveryScope,
) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Primary DB routing, not React.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  const [row] = await primary
    .select()
    .from(teamInviteDeliveries)
    .where(scopeWhere(scope))
    .limit(1);
  return row ?? null;
}

/** Match the team membership writers: team, invitation, then delivery. No SQL
 * lock is held over rendering, Redis or the provider request. */
async function lockTarget(
  tx: TransactionClient,
  scope: TeamInviteDeliveryScope,
) {
  const [team] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, scope.teamId))
    .for("update");
  if (!team) return null;
  const [invite] = await tx
    .select()
    .from(userInvites)
    .where(
      and(
        eq(userInvites.id, scope.inviteId),
        eq(userInvites.teamId, scope.teamId),
      ),
    )
    .for("update");
  if (!invite) return null;
  const [delivery] = await tx
    .select()
    .from(teamInviteDeliveries)
    .where(scopeWhere(scope))
    .for("update");
  if (!delivery) return null;
  let eligible = false;
  if (
    invite.invitedBy &&
    invite.email === delivery.recipient &&
    (invite.role === "member" || invite.role === "owner")
  ) {
    const members = await tx
      .select({ role: usersOnTeam.role })
      .from(usersOnTeam)
      .innerJoin(users, eq(users.id, usersOnTeam.userId))
      .where(
        and(
          eq(usersOnTeam.teamId, scope.teamId),
          eq(usersOnTeam.userId, invite.invitedBy),
          isNull(users.deletionStartedAt),
        ),
      );
    eligible = members.some(
      (member) => invite.role === "member" || member.role === "owner",
    );
  }
  return { invite, delivery, eligible };
}

export async function prepareTeamInviteDelivery(
  db: DatabaseOrTransaction,
  scope: TeamInviteDeliveryScope,
  envelope: string,
) {
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, scope);
    if (!target) return null;
    const row = target.delivery;
    if (row.envelope || row.status !== "pending" || row.firstAttemptAt !== null)
      return row;
    if (!target.eligible) return row; // Claim applies the authoritative stopped state.
    const envelopeHash = teamInviteEnvelopeHash(envelope);
    validateTeamInviteEnvelope(envelope, envelopeHash, row.recipient);
    const [prepared] = await tx
      .update(teamInviteDeliveries)
      .set({ envelope, envelopeHash, updatedAt: sql`clock_timestamp()` })
      .where(scopeWhere(scope))
      .returning();
    return prepared ?? null;
  });
}

export type TeamInviteDeliveryClaim =
  | { state: "claimed"; delivery: TeamInviteDelivery; leaseToken: string }
  | {
      state: "accepted" | "busy" | "unprepared" | "stopped" | "missing";
      delivery: TeamInviteDelivery | null;
    };

export async function claimTeamInviteDelivery(
  db: DatabaseOrTransaction,
  scope: TeamInviteDeliveryScope,
): Promise<TeamInviteDeliveryClaim> {
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, scope);
    if (!target) return { state: "missing", delivery: null };
    const row = target.delivery;
    if (row.status === "accepted") return { state: "accepted", delivery: row };
    if (["canceled", "rejected", "reconciliation"].includes(row.status))
      return { state: "stopped", delivery: row };
    const clock = await tx.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const nowText = clock.rows[0]?.now ?? "";
    const unsafe = invoiceEmailClockIsUnsafe(row, nowText);
    const now = new Date(nowText).getTime();
    const expired =
      row.firstAttemptAt !== null &&
      now - new Date(row.firstAttemptAt).getTime() >=
        TEAM_INVITE_REPLAY_WINDOW_MS;
    const limit = row.attempts >= TEAM_INVITE_MAX_ATTEMPTS;
    if (unsafe || !target.eligible || expired || limit) {
      const status =
        !unsafe && !target.eligible && row.firstAttemptAt === null
          ? "canceled"
          : "reconciliation";
      const [stopped] = await tx
        .update(teamInviteDeliveries)
        .set({
          status,
          lastError: unsafe
            ? "clock_anomaly"
            : !target.eligible
              ? "invitation_changed"
              : expired
                ? "replay_window_expired"
                : "attempt_limit",
          // A real acknowledgement may still arrive for the unchanged fence.
          // This does not authorize another provider request after stopping.
          leaseToken: row.status === "sending" ? row.leaseToken : null,
          leaseExpiresAt: row.status === "sending" ? row.leaseExpiresAt : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(scopeWhere(scope))
        .returning();
      return { state: "stopped", delivery: stopped ?? row };
    }
    if (
      (row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() > now) ||
      new Date(row.nextAttemptAt).getTime() > now
    )
      return { state: "busy", delivery: row };
    if (!row.envelope || !row.envelopeHash)
      return { state: "unprepared", delivery: row };
    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(teamInviteDeliveries)
      .set({
        status: "sending",
        leaseToken,
        leaseExpiresAt: sql`${nowText}::timestamptz + ${TEAM_INVITE_LEASE_SECONDS} * interval '1 second'`,
        firstAttemptAt: row.firstAttemptAt ?? nowText,
        attempts: row.attempts + 1,
        updatedAt: nowText,
      })
      .where(scopeWhere(scope))
      .returning();
    if (!claimed) throw new Error("Invitation email claim disappeared");
    return { state: "claimed", delivery: claimed, leaseToken };
  });
}

export async function recordTeamInviteDeliveryOutcome(
  db: DatabaseOrTransaction,
  scope: TeamInviteDeliveryScope & { leaseToken: string },
  outcome: TeamInviteDeliveryOutcome,
) {
  if (
    outcome.kind === "accepted" &&
    (!outcome.messageId.trim() || outcome.messageId.length > 256)
  )
    throw new Error("Invitation provider receipt is invalid");
  const common = {
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: sql`clock_timestamp()`,
  };
  const [row] = await db
    .update(teamInviteDeliveries)
    .set(
      outcome.kind === "accepted"
        ? {
            ...common,
            status: "accepted",
            providerMessageId: outcome.messageId,
            acceptedAt: sql`clock_timestamp()`,
            lastError: null,
            envelope: null,
          }
        : {
            ...common,
            status: outcome.kind === "retry" ? "pending" : outcome.kind,
            lastError: outcome.code.slice(0, 80),
            nextAttemptAt: sql`clock_timestamp() + least(900, 30 * power(2, least(${teamInviteDeliveries.attempts}, 5))) * interval '1 second'`,
          },
    )
    .where(
      and(
        scopeWhere(scope),
        eq(teamInviteDeliveries.leaseToken, scope.leaseToken),
        outcome.kind === "accepted"
          ? or(
              eq(teamInviteDeliveries.status, "sending"),
              and(
                eq(teamInviteDeliveries.status, "reconciliation"),
                inArray(teamInviteDeliveries.lastError, [
                  "clock_anomaly",
                  "invitation_changed",
                  "replay_window_expired",
                  "attempt_limit",
                ]),
              ),
            )
          : eq(teamInviteDeliveries.status, "sending"),
      ),
    )
    .returning();
  return row ?? null;
}

/** Configuration/template failures occur before HTTP and do not consume the
 * provider replay window. Back off so one row cannot starve the recovery batch. */
export async function deferTeamInviteDelivery(
  db: DatabaseOrTransaction,
  scope: TeamInviteDeliveryScope,
  code: "configuration_unavailable" | "preparation_failed",
) {
  await db
    .update(teamInviteDeliveries)
    .set({
      lastError: code,
      nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        scopeWhere(scope),
        eq(teamInviteDeliveries.status, "pending"),
        isNull(teamInviteDeliveries.firstAttemptAt),
      ),
    );
}

export async function listRecoverableTeamInviteDeliveries(
  db: DatabaseOrTransaction,
  limit = 25,
) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Primary DB routing, not React.
  const primary = "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
  return primary
    .select({
      teamId: teamInviteDeliveries.teamId,
      inviteId: teamInviteDeliveries.inviteId,
      deliveryId: teamInviteDeliveries.id,
    })
    .from(teamInviteDeliveries)
    .where(
      and(
        inArray(teamInviteDeliveries.status, ["pending", "sending"]),
        or(
          sql`clock_timestamp() < greatest(${teamInviteDeliveries.createdAt}, ${teamInviteDeliveries.updatedAt}, ${teamInviteDeliveries.firstAttemptAt})`,
          and(
            lte(teamInviteDeliveries.nextAttemptAt, sql`clock_timestamp()`),
            or(
              isNull(teamInviteDeliveries.leaseExpiresAt),
              lte(teamInviteDeliveries.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          ),
        ),
      ),
    )
    .orderBy(
      asc(teamInviteDeliveries.nextAttemptAt),
      asc(teamInviteDeliveries.createdAt),
    )
    .limit(
      Number.isFinite(limit)
        ? Math.max(1, Math.min(100, Math.trunc(limit)))
        : 25,
    );
}
