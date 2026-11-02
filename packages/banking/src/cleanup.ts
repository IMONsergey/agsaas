export type BankCleanupTarget = {
  provider: "plaid" | "gocardless" | "teller" | "enablebanking" | null;
  referenceId: string | null;
  accessToken: string | null;
};

export type BankCleanupOutcome =
  | { status: "completed"; reason: "revoked" | "already_absent" }
  | { status: "pending"; reason: "provider_rate_limit" }
  | {
      status: "reconciliation";
      reason:
        | "provider_rejected"
        | "provider_uncertain"
        | "provider_identity_missing";
    };

/** Pure preflight. Optional provider absence does not create an HTTP attempt. */
export function isBankCleanupConfigured(
  provider: BankCleanupTarget["provider"],
  env: Record<string, string | undefined> = process.env,
) {
  const has = (...keys: string[]) => keys.every((key) => !!env[key]?.trim());
  switch (provider) {
    case "plaid":
      return has("PLAID_CLIENT_ID", "PLAID_SECRET");
    case "gocardless":
      return has("GOCARDLESS_SECRET_ID", "GOCARDLESS_SECRET_KEY");
    case "teller":
      return has("TELLER_CERT_BASE64", "TELLER_KEY_BASE64");
    case "enablebanking":
      return has(
        "ENABLEBANKING_APPLICATION_ID",
        "ENABLE_BANKING_KEY_CONTENT",
        "ENABLEBANKING_REDIRECT_URL",
      );
    // A corrupt/missing identity is a terminal data problem, not a missing key.
    default:
      return true;
  }
}

async function executeRevoke(target: BankCleanupTarget) {
  if (!target.provider) throw new Error("Missing bank provider");
  const { Provider } = await import("./index.js");
  const provider = new Provider({ provider: target.provider });
  await provider.deleteConnection({
    id: target.referenceId ?? "",
    accessToken: target.accessToken ?? undefined,
  });
}

/** Target deletion only. Unknown/5xx/transport responses are never retried
 * automatically: an accepted revoke may have lost its response. */
export async function revokeBankConnection(
  target: BankCleanupTarget,
  execute: (target: BankCleanupTarget) => Promise<unknown> = executeRevoke,
): Promise<BankCleanupOutcome> {
  if (
    !target.provider ||
    (target.provider === "plaid" || target.provider === "teller"
      ? !target.accessToken?.trim()
      : !target.referenceId?.trim())
  ) {
    return { status: "reconciliation", reason: "provider_identity_missing" };
  }
  try {
    await execute(target);
    return { status: "completed", reason: "revoked" };
  } catch (error) {
    const failure = error as {
      status?: number;
      response?: { status?: number; data?: { error_code?: unknown } };
    } | null;
    const status = failure?.response?.status ?? failure?.status;
    // Plaid explicitly documents ITEM_NOT_FOUND as removed/nonexistent. Do
    // not treat INVALID_ACCESS_TOKEN (also wrong environment/key) as success.
    if (
      target.provider === "plaid" &&
      status === 400 &&
      failure?.response?.data?.error_code === "ITEM_NOT_FOUND"
    ) {
      return { status: "completed", reason: "already_absent" };
    }
    if (status === 429)
      return { status: "pending", reason: "provider_rate_limit" };
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 408
    )
      return { status: "reconciliation", reason: "provider_rejected" };
    return { status: "reconciliation", reason: "provider_uncertain" };
  }
}
