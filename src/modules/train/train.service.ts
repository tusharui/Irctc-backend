
import { prisma } from "../../db/client";

export interface StopRow {
  stationId: string;
  stopIndex: number;
  distanceKm: number;
  arrival: string | null;
  departure: string | null;
}

export interface RouteSegment {
  from: StopRow;
  to: StopRow;
  distanceKm: number;
  /** null when either end has no time, or the route is not yet populated. */
  durationMinutes: number | null;
}

function toMinutes(hhmm: string | null): number | null {
  if (!hhmm) return null;

  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/**
 * Travel time between two clock times on the same route.
 *
 * There are no dates on a timetable, so an arrival that is not after the
 * departure means the train crossed midnight. 21:10 → 09:40 is 12h30m, not
 * negative eleven and a half hours.
 */
export function travelMinutes(
  departure: string | null,
  arrival: string | null
): number | null {
  const start = toMinutes(departure);
  const end = toMinutes(arrival);
  if (start === null || end === null) return null;

  let delta = end - start;
  if (delta <= 0) delta += 24 * 60;

  return delta;
}

/**
 * The segment between two stops, or null if the train does not serve it in
 * that direction.
 *
 * The range is half-open, `[from, to)`, matching `TicketSeat`: a passenger
 * alighting at stop 3 and one boarding at stop 3 do not conflict. That is the
 * whole reason `from.stopIndex >= to.stopIndex` is rejected rather than `>`.
 */
export function resolveSegment(
  stops: StopRow[],
  fromStationId?: string,
  toStationId?: string
): RouteSegment | null {
  if (stops.length < 2) return null;

  const first = stops[0];
  const last = stops[stops.length - 1];

  const from = fromStationId
    ? stops.find((stop) => stop.stationId === fromStationId)
    : first;
  const to = toStationId
    ? stops.find((stop) => stop.stationId === toStationId)
    : last;

  if (!from || !to || from.stopIndex >= to.stopIndex) return null;

  return {
    from,
    to,
    distanceKm: to.distanceKm - from.distanceKm,
    durationMinutes: travelMinutes(from.departure, to.arrival),
  };
}

export interface ClassOccupancy {
  /** Seats held or sold for the date. */
  bookedSeats: number;
  /** Seats an admin took out of service. */
  blockedSeats: number;
}

/**
 * One query per dimension rather than one per class: a train has five classes,
 * and five round trips to Neon per search result is not acceptable.
 */
export async function classOccupancy(
  classIds: string[],
  travelDate: Date
): Promise<Map<string, ClassOccupancy>> {
  const occupancy = new Map<string, ClassOccupancy>();

  for (const id of classIds) {
    occupancy.set(id, { bookedSeats: 0, blockedSeats: 0 });
  }
  if (classIds.length === 0) return occupancy;

  const [booked, blocked] = await Promise.all([
    prisma.bookingSeat.groupBy({
      by: ["trainClassId"],
      where: { trainClassId: { in: classIds }, travelDate },
      _count: { _all: true },
    }),
    prisma.seat.groupBy({
      by: ["trainClassId"],
      where: { trainClassId: { in: classIds }, isAvailable: false },
      _count: { _all: true },
    }),
  ]);

  for (const row of booked) {
    const entry = occupancy.get(row.trainClassId);
    if (entry) entry.bookedSeats = row._count._all;
  }
  for (const row of blocked) {
    const entry = occupancy.get(row.trainClassId);
    if (entry) entry.blockedSeats = row._count._all;
  }

  return occupancy;
}

export function availableSeats(
  totalSeats: number,
  occupancy: ClassOccupancy | undefined
): number {
  const taken = (occupancy?.bookedSeats ?? 0) + (occupancy?.blockedSeats ?? 0);
  return Math.max(0, totalSeats - taken);
}
