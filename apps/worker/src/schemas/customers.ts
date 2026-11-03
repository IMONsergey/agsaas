import { z } from "zod";

/**
 * Customer job schemas
 */

export const enrichCustomerSchema = z.object({
  customerId: z.string().uuid(),
  teamId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
});

export type EnrichCustomerPayload = z.infer<typeof enrichCustomerSchema>;
