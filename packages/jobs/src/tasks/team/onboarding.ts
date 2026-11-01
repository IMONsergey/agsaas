import { onboardTeamSchema } from "@jobs/schema";
import { shouldSendEmail } from "@jobs/utils/check-team-plan";
import { resend } from "@jobs/utils/resend";
import {
  getProductEmailConfig,
  requireProductEmailReceipt,
} from "@midday/email/config";
import { TrialActivationEmail } from "@midday/email/emails/trial-activation";
import { WelcomeEmail } from "@midday/email/emails/welcome";
import { render } from "@midday/email/render";
import { createClient } from "@midday/supabase/job";
import { logger, schemaTask, wait } from "@trigger.dev/sdk";

export const onboardTeam = schemaTask({
  id: "onboard-team",
  schema: onboardTeamSchema,
  maxDuration: 300,
  // Legacy workflow has no durable per-email fence: a replay could duplicate the welcome.
  retry: { maxAttempts: 1 },
  run: async ({ userId }) => {
    const config = getProductEmailConfig();
    const supabase = createClient();

    const { data: user, error } = await supabase
      .from("users")
      .select("id, full_name, email, team_id")
      .eq("id", userId)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    if (!user.full_name || !user.email) {
      throw new Error("User data is missing");
    }

    const [firstName, lastName] = user.full_name.split(" ") ?? [];

    await resend.contacts.create({
      email: user.email,
      firstName,
      lastName,
      unsubscribed: false,
      audienceId: process.env.RESEND_AUDIENCE_ID!,
    });

    requireProductEmailReceipt(
      await resend.emails.send({
        to: user.email,
        subject: `Welcome to ${config.productName}`,
        from: config.from,
        replyTo: config.replyTo,
        html: await render(
          WelcomeEmail({
            fullName: user.full_name,
          }),
        ),
      }),
    );

    if (!user.team_id) {
      logger.info("User has no team, skipping onboarding");
      return;
    }

    // Day 3: Activation nudge — encourage bank connection
    await wait.for({ days: 3 });

    if (await shouldSendEmail(user.team_id)) {
      const { count } = await supabase
        .from("bank_connections")
        .select("id", { count: "exact", head: true })
        .eq("team_id", user.team_id);

      if (!count || count === 0) {
        requireProductEmailReceipt(
          await resend.emails.send({
            from: config.from,
            replyTo: config.replyTo,
            to: user.email,
            subject: "Connect your bank to see the full picture",
            html: await render(
              TrialActivationEmail({ fullName: user.full_name }),
            ),
          }),
        );
      }
    }
  },
});
