import { sql } from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamOwner,
} from "../utils/team-membership";
import { ensureFinancialJobDispatch } from "./financial-job-dispatches";

export type BankSyncScope = { connectionId: string; teamId: string };
export type BankSyncLease = BankSyncScope & {
  leaseToken: string;
  revision: string;
};
export type BankSyncClaim =
  | { state: "busy" | "idle" | "canceled" }
  | {
      state: "claimed";
      leaseToken: string;
      revision: string;
      generation: number;
      latest: boolean;
      connection: {
        id: string;
        teamId: string;
        provider: "plaid" | "teller" | "gocardless" | "enablebanking";
        accessToken: string | null;
        referenceId: string | null;
        enrollmentId: string | null;
        institutionId: string;
      };
      account: {
        id: string;
        accountId: string;
        type:
          | "credit"
          | "depository"
          | "loan"
          | "other_asset"
          | "other_liability";
        currency: string | null;
      };
    };
export type BankSyncStatus = {
  connectionId: string;
  requestedGeneration: number;
  completedGeneration: number;
  processing: boolean | null;
  nextAttemptAt: string;
  lastCompletedAt: string | null;
  reason: string | null;
};
export type BankSyncFailure =
  | "configuration_unavailable"
  | "provider_unavailable"
  | "provider_disconnected"
  | "invalid_provider_data"
  | "lease_expired";
export type BankSyncTransaction = {
  id: string;
  amount: number;
  currency: string;
  date: string;
  status: "posted" | "pending";
  balance: number | null;
  category: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  method: string;
  name: string;
  description: string | null;
};
export type BankSyncBalance = {
  amount: number;
  currency: string;
  available_balance: number | null;
  credit_limit: number | null;
};

function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}

/** Provider callbacks and verified create/reconnect transactions call this.
 * The durable intent commits before any best-effort queue publication. */
export async function requestBankSync(
  db: DatabaseOrTransaction,
  scope: BankSyncScope & { fullHistory?: boolean; eventKey?: string },
) {
  const result = await primary(db).execute<{ accepted: boolean }>(
    sql`SELECT private.request_bank_sync(${scope.connectionId}::uuid,${scope.teamId}::uuid,${scope.fullHistory ?? false},${scope.eventKey ?? null}) accepted`,
  );
  return result.rows[0]?.accepted === true;
}

/** Browser requests also serialize against owner removal or role changes. */
export async function requestBankSyncForOwner(
  db: Database,
  scope: BankSyncScope & { actorId: string },
) {
  return primary(db).transaction(async (tx) => {
    await lockUserMembership(tx, scope.actorId);
    requireTeamOwner(await lockTeamMembership(tx, scope.teamId), scope.actorId);
    return requestBankSync(tx, { ...scope, fullHistory: true });
  });
}

export async function getBankSyncStatus(
  db: DatabaseOrTransaction,
  scope: BankSyncScope,
) {
  const result = await primary(db).execute<{ result: BankSyncStatus | null }>(
    sql`SELECT private.bank_sync_status(${scope.connectionId}::uuid,${scope.teamId}::uuid) result`,
  );
  return result.rows[0]?.result ?? null;
}
export async function listDueBankSync(db: DatabaseOrTransaction, limit = 20) {
  const result = await primary(db).execute<{
    connection_id: string;
    team_id: string;
  }>(
    sql`SELECT * FROM private.list_due_bank_sync(${Math.min(50, Math.max(1, limit))})`,
  );
  return result.rows.map((row) => ({
    connectionId: row.connection_id,
    teamId: row.team_id,
  }));
}
export async function claimBankSync(
  db: DatabaseOrTransaction,
  scope: BankSyncScope,
): Promise<BankSyncClaim> {
  const result = await primary(db).execute<{ result: BankSyncClaim }>(
    sql`SELECT private.claim_bank_sync(${scope.connectionId}::uuid,${scope.teamId}::uuid) result`,
  );
  return result.rows[0]?.result ?? { state: "canceled" };
}
export async function bankSyncLeaseActive(
  db: DatabaseOrTransaction,
  lease: BankSyncLease,
) {
  const result = await primary(db).execute<{ active: boolean }>(
    sql`SELECT private.bank_sync_lease_active(${lease.connectionId}::uuid,${lease.teamId}::uuid,${lease.leaseToken}::uuid,${lease.revision}::uuid) active`,
  );
  return result.rows[0]?.active === true;
}
export async function deferBankSync(
  db: DatabaseOrTransaction,
  lease: BankSyncLease,
  code: BankSyncFailure,
) {
  const result = await primary(db).execute<{ accepted: boolean }>(
    sql`SELECT private.defer_bank_sync(${lease.connectionId}::uuid,${lease.teamId}::uuid,${lease.leaseToken}::uuid,${lease.revision}::uuid,${code}) accepted`,
  );
  return result.rows[0]?.accepted === true;
}

/** SQL data, checkpoint and downstream own-worker intents commit together. */
export async function finishBankSyncAccount(
  db: Database,
  lease: BankSyncLease,
  claim: Extract<BankSyncClaim, { state: "claimed" }>,
  balance: BankSyncBalance | null,
  transactions: BankSyncTransaction[],
) {
  return primary(db).transaction(async (tx) => {
    const result = await tx.execute<{ accepted: boolean }>(
      sql`SELECT private.finish_bank_sync_account(${lease.connectionId}::uuid,${lease.teamId}::uuid,${lease.leaseToken}::uuid,${lease.revision}::uuid,${JSON.stringify(balance)}::jsonb,${JSON.stringify(transactions)}::jsonb) accepted`,
    );
    if (!result.rows[0]?.accepted) return false;
    if (!transactions.length) return true;
    const internalIds = transactions.map(
      (item) => `${lease.teamId}_${item.id}`,
    );
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM public.transactions WHERE team_id=${lease.teamId}::uuid AND bank_account_id=${claim.account.id}::uuid AND internal_id=ANY(${internalIds}::text[]) AND enrichment_completed IS NOT TRUE ORDER BY id`,
    );
    for (let offset = 0; offset < rows.rows.length; offset += 100) {
      const transactionIds = rows.rows
        .slice(offset, offset + 100)
        .map((row) => row.id);
      const source = `bank/${lease.connectionId}/${lease.revision}/${claim.generation}/${claim.account.id}/${offset}`;
      await ensureFinancialJobDispatch(tx, {
        teamId: lease.teamId,
        jobName: "enrich-transactions",
        source,
        payload: { teamId: lease.teamId, transactionIds },
      });
      await ensureFinancialJobDispatch(tx, {
        teamId: lease.teamId,
        jobName: "match-transactions-bidirectional",
        source,
        payload: { teamId: lease.teamId, newTransactionIds: transactionIds },
      });
    }
    return true;
  });
}
