import { getInboxAccountInfo, updateInboxAccount } from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import type { Job } from "bullmq";
import {
  registerDynamicScheduler,
  unregisterDynamicScheduler,
} from "../../schedulers/registry";
import {
  type InboxProviderInitialSetupPayload,
  inboxProviderInitialSetupSchema,
} from "../../schemas/inbox";
import { getDb } from "../../utils/db";
import { NonRetryableError } from "../../utils/error-classification";
import { generateQuarterDailyCronTag } from "../../utils/generate-cron-tag";
import { BaseProcessor } from "../base";

/** Configure the own scheduler only for a live account. Stale setup jobs after
 * disconnect/delete cannot resurrect recurring provider requests. */
export class InitialSetupProcessor extends BaseProcessor<InboxProviderInitialSetupPayload> {
  protected override getPayloadSchema() {
    return inboxProviderInitialSetupSchema;
  }
  async process(job: Job<InboxProviderInitialSetupPayload>) {
    const { inboxAccountId, teamId } = this.validatePayload(job);
    const db = getDb();
    const account = await getInboxAccountInfo(db, { id: inboxAccountId });
    if (!account || account.status === "disconnected") {
      await unregisterDynamicScheduler("inbox-sync-scheduler", inboxAccountId);
      return { inboxAccountId, schedulerRegistered: false };
    }
    if (teamId && teamId !== account.teamId)
      throw new NonRetryableError(
        "Inbox setup scope mismatch",
        undefined,
        "unauthorized",
      );
    await registerDynamicScheduler({
      template: "inbox-sync-scheduler",
      accountId: inboxAccountId,
      cronPattern: generateQuarterDailyCronTag(inboxAccountId),
    });
    await updateInboxAccount(db, {
      id: inboxAccountId,
      scheduleId: `inbox-sync-${inboxAccountId}`,
    });
    const current = await getInboxAccountInfo(db, { id: inboxAccountId });
    if (
      !current ||
      current.teamId !== account.teamId ||
      current.status === "disconnected"
    ) {
      await unregisterDynamicScheduler("inbox-sync-scheduler", inboxAccountId);
      return { inboxAccountId, schedulerRegistered: false };
    }
    const sync = await triggerJob(
      "sync-scheduler",
      { id: inboxAccountId, teamId: account.teamId, manualSync: true },
      "inbox-provider",
    );
    return { inboxAccountId, schedulerRegistered: true, syncJobId: sync.id };
  }
}
