import { z } from "zod";


export const webhookSchema = z
  .object({
    providerEventId: z.string().min(1).max(200),
    event: z.string().min(1).max(100),
    orderId: z.string().min(1).max(200).optional(),
    paymentId: z.string().min(1).max(200).optional(),
    data: z.unknown().optional(),
  })
  .refine((value) => value.paymentId !== undefined || value.orderId !== undefined, {
    message: "Either orderId or paymentId is required",
  });

export type WebhookBody = z.infer<typeof webhookSchema>;
