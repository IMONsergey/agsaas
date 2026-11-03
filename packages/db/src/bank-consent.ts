import { createHash } from "node:crypto";

export type HostedConsentScope = {
  teamId: string;
  userId: string;
  sessionId: string;
};

export type HostedConsentActor = HostedConsentScope & {
  /** The assurance level comes from the verified access token. */
  aal: "aal1" | "aal2";
};

export type HostedConsentStatus =
  | "creating"
  | "awaiting_consent"
  | "exchanging"
  | "grant_received"
  | "verified"
  | "completed"
  | "cleanup_requested"
  | "cleanup_pending"
  | "canceled"
  | "reconciliation";

export type VerifiedConsentAccount = {
  accountId: string;
  name: string;
  currency: string;
  type: "credit" | "depository" | "loan" | "other_asset" | "other_liability";
  subtype: string | null;
};

export type HostedConsentPayload = HostedConsentScope & {
  version: 1;
  id: string;
  provider: "plaid";
  environment: "sandbox" | "production";
  clientFingerprint: string;
  country: "US" | "CA";
  linkToken?: string;
  hostedUrl?: string;
  publicToken?: string;
  linkSessionId?: string;
  accessToken?: string;
  itemId?: string;
  institutionId?: string;
  institutionName?: string;
  accounts?: VerifiedConsentAccount[];
  identityConflict?: boolean;
};

export class BankConsentError extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "scope_changed"
      | "session_expired"
      | "pending_limit"
      | "quota_unavailable"
      | "provider_cleanup_pending"
      | "invalid_provider_data"
      | "connection_exists"
      | "state_changed",
  ) {
    super(`Bank connection cannot proceed: ${reason}`);
    this.name = "BankConsentError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function consentIdentifier(
  value: unknown,
  maximum = 256,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function validateConsentAccounts(
  value: unknown,
): VerifiedConsentAccount[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new BankConsentError("invalid_provider_data");
  const identifiers = new Set<string>();
  const currencies = new Set(Intl.supportedValuesOf("currency"));
  const types = new Set([
    "credit",
    "depository",
    "loan",
    "other_asset",
    "other_liability",
  ]);
  return value.map((account) => {
    if (
      !isRecord(account) ||
      !consentIdentifier(account.accountId) ||
      identifiers.has(account.accountId) ||
      !consentIdentifier(account.name, 250) ||
      typeof account.currency !== "string" ||
      !currencies.has(account.currency) ||
      typeof account.type !== "string" ||
      !types.has(account.type) ||
      (account.subtype !== null && !consentIdentifier(account.subtype, 100))
    )
      throw new BankConsentError("invalid_provider_data");
    identifiers.add(account.accountId);
    return {
      accountId: account.accountId,
      name: account.name,
      currency: account.currency,
      type: account.type as VerifiedConsentAccount["type"],
      subtype: account.subtype as string | null,
    };
  });
}

export function verifyConsentEnvelope(
  value: unknown,
  expected: HostedConsentScope & { id: string },
): HostedConsentPayload {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.provider !== "plaid" ||
    value.id !== expected.id ||
    value.teamId !== expected.teamId ||
    value.userId !== expected.userId ||
    value.sessionId !== expected.sessionId ||
    (value.environment !== "sandbox" && value.environment !== "production") ||
    (value.country !== "US" && value.country !== "CA") ||
    typeof value.clientFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.clientFingerprint)
  )
    throw new BankConsentError("invalid_provider_data");
  for (const key of [
    "linkToken",
    "hostedUrl",
    "publicToken",
    "linkSessionId",
    "accessToken",
    "itemId",
    "institutionId",
    "institutionName",
  ] as const) {
    if (
      value[key] !== undefined &&
      !consentIdentifier(value[key], key === "hostedUrl" ? 8192 : 4096)
    )
      throw new BankConsentError("invalid_provider_data");
  }
  if (value.accounts !== undefined) validateConsentAccounts(value.accounts);
  if (
    value.identityConflict !== undefined &&
    typeof value.identityConflict !== "boolean"
  )
    throw new BankConsentError("invalid_provider_data");
  return value as HostedConsentPayload;
}

/** Cleanup remains possible when the UI feature is disabled, but only with the
 * exact originating provider environment and client identity. Secret rotation
 * for the same client does not change this nonsecret binding. */
export type HostedPlaidClientBinding = {
  environment: "sandbox" | "production";
  clientFingerprint: string;
};

export function hostedPlaidClientBinding(
  env: Record<string, string | undefined>,
): HostedPlaidClientBinding | null {
  const environment = env.PLAID_ENVIRONMENT;
  const clientId = env.PLAID_CLIENT_ID?.trim();
  if ((environment !== "sandbox" && environment !== "production") || !clientId)
    return null;
  return {
    environment,
    clientFingerprint: createHash("sha256")
      .update(`${environment}:${clientId}`)
      .digest("hex"),
  };
}

export function matchesHostedPlaidClient(
  binding: { environment: "sandbox" | "production"; clientFingerprint: string },
  env: Record<string, string | undefined>,
) {
  const current = hostedPlaidClientBinding(env);
  return (
    current !== null &&
    current.environment === binding.environment &&
    current.clientFingerprint === binding.clientFingerprint
  );
}
