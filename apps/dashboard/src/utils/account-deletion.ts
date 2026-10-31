type AccountEntryUser = {
  fullName?: string | null;
  teamId?: string | null;
  deletionStartedAt?: string | Date | null;
};

/** A durable deletion marker takes precedence over missing profile/team data. */
export function getAccountEntryRedirect(
  user: AccountEntryUser | null | undefined,
): "/login" | "/account-deletion" | "/onboarding" | null {
  if (!user) return "/login";
  // Do not expire or reinterpret the timestamp on the client. Only the backend
  // controls this state, including after a timeout or a later sign-in.
  if (user.deletionStartedAt != null) return "/account-deletion";
  if (!user.fullName || !user.teamId) return "/onboarding";
  return null;
}

function errorCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  if (
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "code" in error.data
  ) {
    return error.data.code;
  }
  return "code" in error ? error.code : undefined;
}

/** Fixed UI messages only: never render raw Auth/provider/SQL error details. */
export function getAccountDeletionErrorMessage(
  error: unknown,
  pendingDeletion: boolean,
) {
  const code = errorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Your session has ended or the account may already have been deleted. Sign out and return to login to check its status.";
  }
  if (code === "FORBIDDEN" && !pendingDeletion) {
    return "Account deletion is not permitted yet. If you are the last owner of a shared team, transfer ownership before deleting your account.";
  }
  return pendingDeletion
    ? "Account deletion is still unconfirmed. Retry deletion, or sign out and sign in again to check its status."
    : "Account deletion could not be confirmed. Reload to check its status, or sign out and sign in again. You can retry from the account deletion page if deletion has started.";
}

export function canStartAccountDeletion({
  pendingDeletion,
  confirmation,
  isBusy,
  deletionConfirmed = false,
}: {
  pendingDeletion: boolean;
  confirmation: string;
  isBusy: boolean;
  deletionConfirmed?: boolean;
}) {
  return (
    !isBusy &&
    !deletionConfirmed &&
    (pendingDeletion || confirmation === "DELETE")
  );
}

/** The recovery exit clears only this session, not unrelated signed-in devices. */
export async function tryAccountDeletionSignOut(
  signOut: (options: { scope: "local" }) => Promise<{ error?: unknown }>,
): Promise<boolean> {
  try {
    const { error } = await signOut({ scope: "local" });
    return !error;
  } catch {
    return false;
  }
}
