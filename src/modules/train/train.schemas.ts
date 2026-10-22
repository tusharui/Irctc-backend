import { z } from "zod";
import { travelDateSchema } from "../booking/booking.schemas";

/** Station codes are compared upper-case: "ndls" and "NDLS" are one station. */
export const stationCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .transform((value) => value.toUpperCase());

export const searchTrainsQuerySchema = z
  .object({
    from: stationCodeSchema,
    to: stationCodeSchema,
    /** Optional. Without it, fares are quoted but no availability is shown. */
    date: travelDateSchema.optional(),
  })
  .refine((value) => value.from !== value.to, {
    message: "from and to must be different stations",
    path: ["to"],
  });

export const availabilityQuerySchema = z
  .object({
    date: travelDateSchema,
    /** Optional segment. Both or neither. */
    from: stationCodeSchema.optional(),
    to: stationCodeSchema.optional(),
  })
  .refine((value) => (value.from === undefined) === (value.to === undefined), {
    message: "from and to must be provided together",
    path: ["to"],
  });

export const trainIdParamSchema = z.object({
  id: z.string().min(1),
});

export type SearchTrainsQuery = z.infer<typeof searchTrainsQuerySchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
