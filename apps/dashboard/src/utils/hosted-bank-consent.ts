export type HostedConsentSummary = {
  id: string;
  status: string;
  connectionId: string | null;
  url?: string;
};

export type HostedConsentCommand = {
  requestId: string;
  country: "US" | "CA";
};

/** The server derives this opaque namespace from the current actor/team/session. */
export function hostedBankConsentStorageKey(
  commandScope: unknown,
): string | null {
  return typeof commandScope === "string" && /^[a-f0-9]{64}$/.test(commandScope)
    ? `agsaas.bank-consent-command.v2:${commandScope}`
    : null;
}

/** A browser command key is only an idempotency reference, never consent proof. */
export function pendingHostedConsentCommand(
  value: string | null,
): HostedConsentCommand | null {
  if (!value || value.length > 256) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !("requestId" in parsed) ||
      !("country" in parsed) ||
      typeof parsed.requestId !== "string" ||
      !bankConsentId(parsed.requestId) ||
      (parsed.country !== "US" && parsed.country !== "CA")
    )
      return null;
    return { requestId: parsed.requestId, country: parsed.country };
  } catch {
    return null;
  }
}

export function hostedBankConsentError(error: unknown): string {
  let code: unknown;
  if (
    error &&
    typeof error === "object" &&
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "code" in error.data
  )
    code = error.data.code;
  switch (code) {
    case "FORBIDDEN":
      return "Only a current team owner can manage bank connections.";
    case "UNAUTHORIZED":
      return "Sign in again and complete any required verification.";
    case "NOT_FOUND":
      return "This request is unavailable for the current account and sign-in session.";
    case "TOO_MANY_REQUESTS":
      return "Review pending bank connections before starting another request.";
    case "PRECONDITION_FAILED":
      return "Check the team's connection allowance and any pending provider cleanup before continuing.";
    case "SERVICE_UNAVAILABLE":
      return "Bank consent is currently unavailable. Existing requests remain saved.";
    case "CONFLICT":
      return "The connection or request has changed. Refresh its status before continuing.";
    default:
      return "The request could not be confirmed. Refresh its status before continuing.";
  }
}

export function bankConsentId(value: string | null | undefined): string | null {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

/** Navigation uses only a fresh server response from the configured flow. */
export function hostedBankNavigationUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "secure.plaid.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function hostedBankConsentPresentation(row: HostedConsentSummary) {
  const base = {
    accepted: false,
    terminal: false,
    canOpen: false,
    canVerify: false,
    canCancel: false,
    needsReview: false,
  };
  if (!bankConsentId(row.id))
    return {
      ...base,
      title: "Status unavailable",
      description: "Refresh the bank connection status before continuing.",
    };
  switch (row.status) {
    case "creating":
      return {
        ...base,
        canCancel: true,
        title: "Preparing bank consent",
        description:
          "The request is still being prepared. Refresh its status before starting another connection.",
      };
    case "awaiting_consent": {
      const canOpen = hostedBankNavigationUrl(row.url) !== null;
      return {
        ...base,
        canOpen,
        canVerify: canOpen,
        canCancel: true,
        title: "Waiting for bank consent",
        description: canOpen
          ? "Continue at Plaid, then verify the connection here. Returning from Plaid does not confirm a connection."
          : "This consent link is unavailable or expired. Refresh the status or cancel this attempt.",
      };
    }
    case "exchanging":
      return {
        ...base,
        canCancel: true,
        title: "Verifying bank consent",
        description:
          "A verification is already in progress. Refresh the status to see its result.",
      };
    case "grant_received":
      return {
        ...base,
        canVerify: true,
        canCancel: true,
        title: "Account verification pending",
        description:
          "Plaid returned access, but the accounts have not been verified and saved yet.",
      };
    case "verified":
      return {
        ...base,
        canVerify: true,
        canCancel: true,
        title: "Saving verified accounts",
        description: "Finish verification to add the accounts to this team.",
      };
    case "completed":
      if (bankConsentId(row.connectionId))
        return {
          ...base,
          accepted: true,
          terminal: true,
          title: "Connection verified",
          description:
            "The accounts were added to this team. Current connection and sync status are shown in Bank connections.",
        };
      break;
    case "cleanup_requested":
    case "cleanup_pending":
      return {
        ...base,
        title: "Cancellation pending",
        description:
          "The cancellation is saved. Confirmation that Plaid access has been revoked is still pending.",
      };
    case "canceled":
      return {
        ...base,
        terminal: true,
        title: "Cancellation confirmed",
        description: "Provider cleanup was confirmed for this request.",
      };
    case "reconciliation":
      return {
        ...base,
        needsReview: true,
        title: "Administrator review needed",
        description:
          "The result could not be confirmed. Ask your administrator to review this request with Plaid before starting another connection.",
      };
  }
  return {
    ...base,
    title: "Status unavailable",
    description: "Refresh the bank connection status before continuing.",
  };
}
