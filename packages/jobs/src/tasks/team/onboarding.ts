import { onboardTeamSchema } from "@jobs/schema";
import { schemaTask } from "@trigger.dev/sdk";

/** Retained only so a previously registered external task fails visibly. */
export const onboardTeam = schemaTask({
  id: "onboard-team",
  schema: onboardTeamSchema,
  maxDuration: 30,
  retry: { maxAttempts: 1 },
  run: async () => {
    throw new Error(
      "Legacy onboarding is disabled; registration delivery belongs to the native database worker",
    );
  },
});
