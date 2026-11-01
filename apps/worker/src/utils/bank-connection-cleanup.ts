import {
  isBankCleanupConfigured,
  revokeBankConnection,
} from "@midday/banking/cleanup";
import type {
  BankCleanupOutcome,
  BankCleanupTarget,
} from "@midday/db/bank-connection-cleanup";
import type { Database } from "@midday/db/client";
import {
  beginBankConnectionCleanup,
  finishBankConnectionCleanup,
  getBankConnectionCleanup,
  interruptBankConnectionCleanup,
  openBankConnectionCleanup,
} from "@midday/db/queries/bank-connection-cleanups";

type Dependencies = {
  configured: (provider: BankCleanupTarget["provider"]) => boolean;
  revoke: (target: BankCleanupTarget) => Promise<BankCleanupOutcome>;
};

export async function cleanupBankConnection(
  db: Database,
  id: string,
  dependencies: Dependencies = {
    configured: isBankCleanupConfigured,
    revoke: revokeBankConnection,
  },
) {
  const existing = await getBankConnectionCleanup(db, id);
  if (!existing) return { status: "missing" as const };
  if (existing.status === "completed" || existing.status === "reconciliation")
    return { status: existing.status };
  let target: BankCleanupTarget | null = null;
  try {
    target = openBankConnectionCleanup(existing);
  } catch {
    /* Preserve credentials until the correct key is available. */
  }
  const ready = target !== null && dependencies.configured(target.provider);
  const claim = await beginBankConnectionCleanup(db, id, ready);
  if (claim.state !== "claimed") return { status: claim.state };
  try {
    // Read the immutable target from the fenced row, not an earlier snapshot.
    const outcome = await dependencies.revoke(
      openBankConnectionCleanup(claim.row),
    );
    const settled = await finishBankConnectionCleanup(
      db,
      id,
      claim.token,
      outcome,
    );
    if (!settled) throw new Error("Bank cleanup receipt was not persisted");
    return { status: settled.status };
  } catch {
    // SQL failure after HTTP or an unexpected transport throw cannot become
    // a second automatic revoke. Leave a durable, operator-visible fence.
    await interruptBankConnectionCleanup(db, id, claim.token);
    throw new Error("Bank cleanup requires reconciliation");
  }
}
