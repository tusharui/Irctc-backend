import { z } from "zod";


export const travelDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD form")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Not a valid calendar date");

/** Turn "YYYY-MM-DD" into the UTC-midnight Date a DATE column expects. */
export function parseTravelDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export const passengerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  age: z.number().int().min(0).max(130),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  berthPreference: z.string().trim().max(20).optional(),
  /** Each passenger occupies exactly one seat. */
  seatId: z.string().min(1),
});

export const createBookingSchema = z
  .object({
    trainId: z.string().min(1),
    travelDate: travelDateSchema,
    /** Minutes the seats stay held while payment is attempted. */
    holdMinutes: z.number().int().min(1).max(60).optional(),
    /**
     * Boarding/alighting stops, as indices into the train's ordered route.
     * Omit both to book the whole run. They travel together: one without the
     * other is a client bug and is rejected rather than silently defaulted.
     */
    fromStopIndex: z.number().int().min(0).optional(),
    toStopIndex: z.number().int().min(0).optional(),
    passengers: z.array(passengerSchema).min(1).max(6),
  })
  .refine(
    (value) =>
      new Set(value.passengers.map((p) => p.seatId)).size ===
      value.passengers.length,
    {
      message: "The same seat cannot be assigned to two passengers",
      path: ["passengers"],
    }
  )
  .refine(
    (value) =>
      (value.fromStopIndex === undefined) === (value.toStopIndex === undefined),
    { message: "fromStopIndex and toStopIndex must be provided together", path: ["toStopIndex"] }
  )
  .refine(
    (value) =>
      value.fromStopIndex === undefined ||
      value.toStopIndex === undefined ||
      value.fromStopIndex < value.toStopIndex,
    { message: "fromStopIndex must come before toStopIndex", path: ["toStopIndex"] }
  );

export const bookingIdParamSchema = z.object({
  id: z.string().min(1),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type PassengerBody = z.infer<typeof passengerSchema>;
