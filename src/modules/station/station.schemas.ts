import { z } from "zod";

/** Station codes are compared upper-case: "ndls" and "NDLS" are one station. */
export const stationCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .transform((value) => value.toUpperCase());

/**
 * `limit` arrives as a string from the query string, so coerce it. A client
 * sending `?limit=999` gets 50, not an unbounded scan.
 */
export const stationSearchQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type StationSearchQuery = z.infer<typeof stationSearchQuerySchema>;
