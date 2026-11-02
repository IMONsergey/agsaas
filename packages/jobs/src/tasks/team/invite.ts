import { resend } from "@jobs/utils/resend";
import {
  getProductEmailConfig,
  requireProductEmailBatchReceipt,
} from "@midday/email/config";
import { InviteEmail } from "@midday/email/emails/invite";
import { getI18n } from "@midday/email/locales";
import { render } from "@midday/email/render";
import { inviteTeamMembersSchema } from "@midday/jobs/schema";
import { schemaTask } from "@trigger.dev/sdk";
import { nanoid } from "nanoid";

export const inviteTeamMembers = schemaTask({
  id: "invite-team-members",
  schema: inviteTeamMembersSchema,
  maxDuration: 30,
  // This legacy task has no durable envelope. A partial/unknown batch must not
  // be replayed automatically; the self-hosted app uses its SQL invite outbox.
  retry: { maxAttempts: 1 },
  queue: {
    concurrencyLimit: 10,
  },
  run: async ({ ip, invites, locale }) => {
    const config = getProductEmailConfig();
    const { t } = getI18n({ locale });

    const emails = invites?.map(async (invite) => ({
      from: config.from,
      replyTo: config.replyTo,
      to: [invite.email],
      subject: t("invite.subject", {
        invitedByName: invite.invitedByName,
        teamName: invite.teamName,
      }),
      headers: {
        "X-Entity-Ref-ID": nanoid(),
      },
      html: await render(
        InviteEmail({
          invitedByEmail: invite.invitedByEmail,
          invitedByName: invite.invitedByName,
          email: invite.email,
          teamName: invite.teamName,
          ip,
          locale,
          appUrl: config.appUrl,
          productName: config.productName,
        }),
      ),
    }));

    const htmlEmails = await Promise.all(emails);

    requireProductEmailBatchReceipt(
      await resend.batch.send(htmlEmails),
      htmlEmails.length,
    );
  },
});
