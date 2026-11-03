import type { OnboardingScope } from "@midday/db/queries/onboarding-deliveries";
import { deliverOnboarding } from "@midday/notifications/onboarding-delivery";
import type { Job } from "bullmq";
import { z } from "zod";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
export class DeliverOnboardingProcessor extends BaseProcessor<OnboardingScope> {
  protected getPayloadSchema() {
    return z
      .object({ deliveryId: z.string().uuid(), userId: z.string().uuid() })
      .strict();
  }
  async process(job: Job<OnboardingScope>) {
    return deliverOnboarding(getDb(), job.data);
  }
}
