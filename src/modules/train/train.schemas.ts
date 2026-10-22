import { z } from "zod";
import { travelDateSchema } from "../booking/booking.schemas";
import { stationCodeSchema } from "../station/station.schemas";

export const searchTrainsQuerySchema = z
  .object({
    from: stationCodeSchema,
    to: stationCodeSchema,
    /** The service date. Without it you get timetables and fares, no journeys. */
    date: travelDateSchema.optional(),
  })
  .refine((value) => value.from !== value.to, {
    message: "from and to must be different stations",
    path: ["to"],
  });

/**
 * A journey already knows its date, so availability only needs an optional
 * segment. Both stations or neither.
 */
export const journeyAvailabilityQuerySchema = z
  .object({
    from: stationCodeSchema.optional(),
    to: stationCodeSchema.optional(),
  })
  .refine((value) => (value.from === undefined) === (value.to === undefined), {
    message: "from and to must be provided together",
    path: ["to"],
  });

export const journeyIdParamSchema = z.object({
  journeyId: z.string().min(1),
});

export type SearchTrainsQuery = z.infer<typeof searchTrainsQuerySchema>;
export type JourneyAvailabilityQuery = z.infer<
  typeof journeyAvailabilityQuerySchema
>;
