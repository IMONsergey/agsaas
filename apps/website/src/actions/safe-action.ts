import { createSafeActionClient } from "next-safe-action";
export const actionClient = createSafeActionClient({
  handleServerError(error) {
    // Action errors are authored public messages; transports never include secrets.
    return error instanceof Error &&
      /^(Support messaging|Too many requests|Receipt could not)/.test(
        error.message,
      )
      ? error.message
      : "Request could not be confirmed. Your text is preserved; please try again.";
  },
});
