import type { TeamInviteDeliveryScope } from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";

/** SQL intent is the source of truth. This only wakes the teams worker sooner;
 * bounded failure is recovered by the persisted-intent scanner. */
export async function enqueueTeamInvitations(
  scopes: TeamInviteDeliveryScope[],
  enqueue: typeof triggerJob = triggerJob,
  deadlineMs = 1000,
): Promise<void> {
  if (scopes.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(
        scopes.map((scope) =>
          Promise.resolve().then(() =>
            enqueue("deliver-team-invitation", scope, "teams", {
              jobId: `team-invite-${scope.deliveryId}`,
            }),
          ),
        ),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
