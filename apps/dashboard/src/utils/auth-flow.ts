type AuthOperationResult<Session> = {
  data: { session: Session | null } | null;
  error: unknown;
};

/** Only accept the session returned by this successful Auth operation. */
export async function getAuthOperationSession<Session>(
  authenticate: () => Promise<AuthOperationResult<Session>>,
): Promise<Session | null> {
  try {
    const { data, error } = await authenticate();
    return error ? null : (data?.session ?? null);
  } catch {
    return null;
  }
}

type AuthRequestHandlers = {
  request: () => Promise<{ error?: unknown }>;
  setPending: (pending: boolean) => void;
  onSuccess?: () => void;
  onError: (error: unknown) => void;
};

/** Supabase returns many failures as values; transport failures may reject. */
export async function runAuthRequest({
  request,
  setPending,
  onSuccess,
  onError,
}: AuthRequestHandlers): Promise<void> {
  setPending(true);
  try {
    const { error } = await request();
    if (error) throw error;
    onSuccess?.();
  } catch (error) {
    onError(error);
  } finally {
    setPending(false);
  }
}

export function getAuthCallbackErrorMessage(error: string | null) {
  // Never render error_description or other untrusted callback URL content.
  return error === "auth_callback"
    ? "The sign-in link is invalid or has expired. Please try signing in again."
    : null;
}
