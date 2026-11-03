import { sql } from "drizzle-orm";
import type {
  Database,
  DatabaseWithPrimary,
  TransactionClient,
} from "../client";
import { TeamMembershipError } from "../errors";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "../utils/team-membership";
import { assertNoPendingProviderCleanup } from "./resource-cleanups";
import { appendSecurityAuditEvent } from "./security-audit";

export type IntegrationOAuthProvider =
  | "xero"
  | "quickbooks"
  | "fortnox"
  | "slack"
  | "stripe";
export type IntegrationOAuthIntent = {
  id: string;
  userId: string;
  teamId: string;
  provider: IntegrationOAuthProvider;
  source: "apps" | "invoice-settings";
  aal: "aal1" | "aal2";
};
export type CreateIntegrationOAuthIntentParams = Omit<
  IntegrationOAuthIntent,
  "id"
> & {
  stateHash: string;
  browserNonceHash: string;
};
type Binding = Pick<
  CreateIntegrationOAuthIntentParams,
  "stateHash" | "browserNonceHash" | "provider"
>;

function primary(db: Database) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Drizzle primary routing is not a React hook.
  return (db as DatabaseWithPrimary).usePrimaryOnly?.() ?? db;
}
async function lockOwner(
  tx: TransactionClient,
  intent: Pick<IntegrationOAuthIntent, "userId" | "teamId">,
) {
  await lockUserMembership(tx, intent.userId);
  requireTeamOwner(await lockTeamMembership(tx, intent.teamId), intent.userId);
}
const fields = sql`id, user_id AS "userId", team_id AS "teamId", provider, source, aal`;

/** Raw state and browser nonce are never persisted. Installation requires a current owner. */
export async function createIntegrationOAuthIntent(
  db: Database,
  params: CreateIntegrationOAuthIntentParams,
) {
  return primary(db).transaction(async (tx) => {
    await lockOwner(tx, params);
    await assertNoPendingProviderCleanup(tx, params.teamId, params.provider);
    // Each actor/provider has one live handshake. A new start invalidates old tabs.
    await tx.execute(sql`DELETE FROM public.integration_oauth_intents
      WHERE user_id = ${params.userId} AND (provider = ${params.provider} OR expires_at < now())`);
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO public.integration_oauth_intents
        (state_hash, browser_nonce_hash, user_id, team_id, provider, source, aal, expires_at)
      VALUES (${params.stateHash}, ${params.browserNonceHash}, ${params.userId}, ${params.teamId},
        ${params.provider}, ${params.source}, ${params.aal}, now() + interval '10 minutes')
      RETURNING id`);
    return result.rows[0]!;
  });
}

/** Lookup is used only for authoritative MFA before the atomic consume. */
export async function findIntegrationOAuthIntent(
  db: Database,
  binding: Binding,
) {
  const result = await primary(db).execute<IntegrationOAuthIntent>(sql`
    SELECT ${fields} FROM public.integration_oauth_intents
    WHERE state_hash = ${binding.stateHash} AND browser_nonce_hash = ${binding.browserNonceHash}
      AND provider = ${binding.provider} AND consumed_at IS NULL AND expires_at > now()`);
  return result.rows[0] ?? null;
}

/** Owner changes and concurrent callbacks serialize with the final conditional update. */
export async function consumeIntegrationOAuthIntent(
  db: Database,
  binding: Binding,
) {
  const candidate = await findIntegrationOAuthIntent(db, binding);
  if (!candidate) return null;
  try {
    return await primary(db).transaction(async (tx) => {
      await lockOwner(tx, candidate);
      const result = await tx.execute<IntegrationOAuthIntent>(sql`
        UPDATE public.integration_oauth_intents SET consumed_at = now()
        WHERE id = ${candidate.id} AND state_hash = ${binding.stateHash}
          AND browser_nonce_hash = ${binding.browserNonceHash} AND provider = ${binding.provider}
          AND consumed_at IS NULL AND expires_at > now() RETURNING ${fields}`);
      return result.rows[0] ?? null;
    });
  } catch (error) {
    if (error instanceof TeamMembershipError) return null;
    throw error;
  }
}

/**
 * Provider HTTP runs outside SQL locks. Persist only after another locked owner
 * check, atomically with completing the claimed intent; never accept actor IDs
 * from the callback query or a legacy encrypted state.
 */
export async function completeIntegrationOAuthIntent<T>(
  db: Database,
  intent: IntegrationOAuthIntent,
  write: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return primary(db).transaction(async (tx) => {
    await lockOwner(tx, intent);
    await assertNoPendingProviderCleanup(tx, intent.teamId, intent.provider);
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE public.integration_oauth_intents SET completed_at = now()
      WHERE id = ${intent.id} AND user_id = ${intent.userId} AND team_id = ${intent.teamId}
        AND provider = ${intent.provider} AND consumed_at IS NOT NULL
        AND completed_at IS NULL AND expires_at > now() RETURNING id`);
    if (!result.rows[0])
      throw new Error("Integration authorization is no longer valid");
    const written = await write(tx);
    if (intent.provider === "stripe")
      await appendSecurityAuditEvent(tx, {
        teamId: intent.teamId,
        actorUserId: intent.userId,
        operation: "integration.connect",
        targetType: "integration",
        targetId: "stripe",
        metadata: { provider: "stripe", connected: true },
      });
    return written;
  });
}
