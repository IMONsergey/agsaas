import { and, eq, exists, gt, isNull, lt, sql } from "drizzle-orm";
import type { Database, DatabaseWithPrimary } from "../client";
import { inboxOAuthIntents, users, usersOnTeam } from "../schema";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamMember,
} from "../utils/team-membership";

export type CreateInboxOAuthIntentParams = {
  stateHash: string;
  browserNonceHash: string;
  userId: string;
  teamId: string;
  provider: "gmail" | "outlook";
  source: "inbox" | "apps";
  aal: "aal1" | "aal2";
  redirectPath?: string;
};

function primary(db: Database) {
  const primaryOnly = (db as DatabaseWithPrimary).usePrimaryOnly;
  return primaryOnly ? primaryOnly.call(db) : db;
}

/** Store only digests; state and browser nonce leave this function unrecorded. */
export async function createInboxOAuthIntent(
  db: Database,
  params: CreateInboxOAuthIntentParams,
) {
  return primary(db).transaction(async (tx) => {
    await lockUserMembership(tx, params.userId);
    const members = await lockTeamMembership(tx, params.teamId);
    requireTeamMember(members, params.userId);

    // Bound retention for repeat users without retaining an authorization log.
    await tx
      .delete(inboxOAuthIntents)
      .where(
        and(
          eq(inboxOAuthIntents.userId, params.userId),
          lt(inboxOAuthIntents.expiresAt, sql`now() - interval '1 hour'`),
        ),
      );
    const [intent] = await tx
      .insert(inboxOAuthIntents)
      .values({
        ...params,
        createdAt: sql`now()`,
        expiresAt: sql`now() + interval '10 minutes'`,
      })
      .returning({ id: inboxOAuthIntents.id });
    return intent!;
  });
}

/**
 * One conditional UPDATE is the consume boundary across processes/restarts.
 * The current actor and membership are checked on the primary, not metadata.
 * A callback rejected for a wrong cookie/provider cannot consume a valid intent.
 */
export async function consumeInboxOAuthIntent(
  db: Database,
  params: Pick<
    CreateInboxOAuthIntentParams,
    "stateHash" | "browserNonceHash" | "provider"
  >,
) {
  const authDb = primary(db);
  const activeMembership = authDb
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      usersOnTeam,
      and(
        eq(usersOnTeam.userId, users.id),
        eq(usersOnTeam.teamId, inboxOAuthIntents.teamId),
      ),
    )
    .where(
      and(
        eq(users.id, inboxOAuthIntents.userId),
        isNull(users.deletionStartedAt),
      ),
    );

  const [intent] = await authDb
    .update(inboxOAuthIntents)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(inboxOAuthIntents.stateHash, params.stateHash),
        eq(inboxOAuthIntents.browserNonceHash, params.browserNonceHash),
        eq(inboxOAuthIntents.provider, params.provider),
        isNull(inboxOAuthIntents.consumedAt),
        gt(inboxOAuthIntents.expiresAt, sql`now()`),
        exists(activeMembership),
      ),
    )
    .returning({
      id: inboxOAuthIntents.id,
      userId: inboxOAuthIntents.userId,
      teamId: inboxOAuthIntents.teamId,
      provider: inboxOAuthIntents.provider,
      source: inboxOAuthIntents.source,
      redirectPath: inboxOAuthIntents.redirectPath,
      aal: inboxOAuthIntents.aal,
    });
  return intent ?? null;
}
