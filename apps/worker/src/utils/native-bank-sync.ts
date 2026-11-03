import { Provider } from "@midday/banking";
import type { Database } from "@midday/db/client";
import {
  type BankSyncBalance,
  type BankSyncClaim,
  type BankSyncScope,
  type BankSyncTransaction,
  bankSyncLeaseActive,
  claimBankSync,
  deferBankSync,
  finishBankSyncAccount,
} from "@midday/db/queries/bank-sync";
import {
  balanceSchema,
  bankProviderConfigured,
  validateBankTransactions,
} from "./native-bank-payload";
import { withTimeout } from "./timeout";

type Claim = Extract<BankSyncClaim, { state: "claimed" }>;
type ProviderReader = Pick<
  Provider,
  "getConnectionStatus" | "getAccountBalance" | "getTransactions"
>;

/** One account per bounded claim. Larger connections progress through durable
 * account checkpoints; a restart or lost Redis job resumes from SQL. */
export async function runNativeBankSync(
  db: Database,
  scope: BankSyncScope,
  options: {
    provider?: (
      kind: Claim["connection"]["provider"],
      signal: AbortSignal,
    ) => ProviderReader;
    configured?: (kind: Claim["connection"]["provider"]) => boolean;
  } = {},
) {
  const claim = await claimBankSync(db, scope);
  if (claim.state !== "claimed") return { status: claim.state };
  const lease = {
    ...scope,
    leaseToken: claim.leaseToken,
    revision: claim.revision,
  };
  if (
    !(options.configured ?? bankProviderConfigured)(claim.connection.provider)
  ) {
    await deferBankSync(db, lease, "configuration_unavailable");
    return { status: "blocked", reason: "configuration_unavailable" };
  }
  const provider =
    options.provider ??
    ((kind, signal) => new Provider({ provider: kind, signal }));
  const active = () => bankSyncLeaseActive(db, lease);
  let invalidData = false;
  try {
    if (!(await active())) return { status: "stale" };
    const connection = claim.connection;
    const accessToken = connection.accessToken ?? undefined;
    const status = await withTimeout(
      (signal) =>
        provider(connection.provider, signal).getConnectionStatus({
          id: connection.referenceId ?? connection.enrollmentId ?? undefined,
          accessToken,
        }),
      15_000,
      "Bank provider status timed out",
    );
    if (status.status === "disconnected") {
      await deferBankSync(db, lease, "provider_disconnected");
      return { status: "disconnected" };
    }
    if (!(await active())) return { status: "stale" };
    const rawBalance = await withTimeout(
      (signal) =>
        provider(connection.provider, signal).getAccountBalance({
          accountId: claim.account.accountId,
          accessToken,
          accountType: claim.account.type,
        }),
      25_000,
      "Bank balance timed out",
    );
    if (!(await active())) return { status: "stale" };
    const rawTransactions = await withTimeout(
      (signal) =>
        provider(connection.provider, signal).getTransactions({
          accountId: claim.account.accountId,
          accessToken,
          accountType: claim.account.type,
          latest: claim.latest === true,
        }),
      35_000,
      "Bank transactions timed out",
    );
    let balance: BankSyncBalance | null;
    let transactions: BankSyncTransaction[];
    try {
      balance = balanceSchema.parse(rawBalance);
      // XXX is the provider's unknown-currency marker, never an authoritative
      // zero or permission to erase the last known balance.
      if (balance.currency === "XXX") balance = null;
      transactions = validateBankTransactions(rawTransactions);
    } catch {
      invalidData = true;
      throw new Error("Invalid provider data");
    }
    const accepted = await finishBankSyncAccount(
      db,
      lease,
      claim,
      balance,
      transactions,
    );
    return {
      status: accepted ? "synchronized" : "stale",
      ...(accepted ? { transactions: transactions.length } : {}),
    };
  } catch (error) {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < 3 && current && typeof current === "object";
      depth++
    ) {
      const value = current as { code?: unknown; cause?: unknown };
      if (
        typeof value.code === "string" &&
        (/^22/.test(value.code) || value.code === "23514")
      )
        invalidData = true;
      current = value.cause;
    }
    await deferBankSync(
      db,
      lease,
      invalidData ? "invalid_provider_data" : "provider_unavailable",
    );
    // No provider error body, token or SQL parameters enter Redis or telemetry.
    return {
      status: "pending",
      reason: invalidData ? "invalid_provider_data" : "provider_unavailable",
    };
  }
}
