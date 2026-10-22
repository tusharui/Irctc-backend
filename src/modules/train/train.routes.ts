import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";
import { zValidator } from "../../lib/validation";
import type { AuthVariables } from "../../middleware/auth";
import { parseTravelDate } from "../booking/booking.schemas";
import { seatFare } from "../booking/reservation.service";
import {
  availabilityQuerySchema,
  searchTrainsQuerySchema,
  trainIdParamSchema,
} from "./train.schemas";
import {
  availableSeats,
  classOccupancy,
  resolveSegment,
  type ClassOccupancy,
  type RouteSegment,
} from "./train.service";

export const trainRoutes = new Hono<{ Variables: AuthVariables }>();

const classSelect = {
  id: true,
  classType: true,
  coachCount: true,
  seatsPerCoach: true,
  totalSeats: true,
  baseFare: true,
  farePerKm: true,
} as const;

const stopSelect = {
  stationId: true,
  stopIndex: true,
  distanceKm: true,
  arrival: true,
  departure: true,
} as const;

interface ClassRow {
  id: string;
  classType: string;
  coachCount: number;
  seatsPerCoach: number;
  totalSeats: number;
  baseFare: number;
  farePerKm: number;
}

/**
 * One class, priced for the segment and — when a date was supplied — with
 * live counts. `availableSeats` is derived, never stored.
 */
function classView(
  cls: ClassRow,
  distanceKm: number,
  occupancy: Map<string, ClassOccupancy> | null
) {
  const fare = seatFare(cls, distanceKm);

  if (!occupancy) {
    return {
      classType: cls.classType,
      coachCount: cls.coachCount,
      seatsPerCoach: cls.seatsPerCoach,
      totalSeats: cls.totalSeats,
      fare,
    };
  }

  const occ = occupancy.get(cls.id);
  return {
    classType: cls.classType,
    coachCount: cls.coachCount,
    seatsPerCoach: cls.seatsPerCoach,
    totalSeats: cls.totalSeats,
    fare,
    bookedSeats: occ?.bookedSeats ?? 0,
    blockedSeats: occ?.blockedSeats ?? 0,
    availableSeats: availableSeats(cls.totalSeats, occ),
  };
}

function segmentView(segment: RouteSegment) {
  return {
    fromStopIndex: segment.from.stopIndex,
    toStopIndex: segment.to.stopIndex,
    distanceKm: segment.distanceKm,
    durationMinutes: segment.durationMinutes,
  };
}

async function stationsByCode(codes: string[]) {
  const stations = await prisma.station.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true, city: true },
  });

  const byCode = new Map(stations.map((station) => [station.code, station]));
  const missing = codes.filter((code) => !byCode.has(code));

  if (missing.length > 0) {
    throw new HTTPException(404, {
      message: `Unknown station code: ${missing.join(", ")}`,
    });
  }

  return byCode;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/trains/search?from=NDLS&to=BCT&date=2027-01-15
//
// A train matches when it visits both stations in that order. `date` is
// optional: without it you get timetables and fares, with it you also get
// availability counts.
// ────────────────────────────────────────────────────────────────────

trainRoutes.get(
  "/api/trains/search",
  zValidator("query", searchTrainsQuerySchema),
  async (c) => {
    const { from, to, date } = c.req.valid("query");

    const byCode = await stationsByCode([from, to]);
    const fromStation = byCode.get(from)!;
    const toStation = byCode.get(to)!;

    const travelDate = date ? parseTravelDate(date) : null;

    const trains = await prisma.train.findMany({
      where: {
        isActive: true,
        stops: { some: { stationId: fromStation.id } },
        AND: [{ stops: { some: { stationId: toStation.id } } }],
      },
      select: {
        id: true,
        number: true,
        name: true,
        classes: { select: classSelect, orderBy: { classType: "asc" } },
        stops: { select: stopSelect, orderBy: { stopIndex: "asc" } },
      },
      orderBy: { number: "asc" },
    });

    // Prisma cannot express "stop A comes before stop B on the same train"
    // without a self-join, so the ordering check is done here over the
    // already-fetched route.
    const matched = trains.flatMap((train) => {
      const segment = resolveSegment(
        train.stops,
        fromStation.id,
        toStation.id
      );
      return segment ? [{ train, segment }] : [];
    });

    const occupancy = travelDate
      ? await classOccupancy(
          matched.flatMap(({ train }) => train.classes.map((cls) => cls.id)),
          travelDate
        )
      : null;

    const results = matched.map(({ train, segment }) => ({
      train: { id: train.id, number: train.number, name: train.name },
      from: {
        code: fromStation.code,
        name: fromStation.name,
        city: fromStation.city,
        stopIndex: segment.from.stopIndex,
        departure: segment.from.departure,
        distanceKm: segment.from.distanceKm,
      },
      to: {
        code: toStation.code,
        name: toStation.name,
        city: toStation.city,
        stopIndex: segment.to.stopIndex,
        arrival: segment.to.arrival,
        distanceKm: segment.to.distanceKm,
      },
      segment: segmentView(segment),
      classes: train.classes
        .map((cls) => classView(cls, segment.distanceKm, occupancy))
        .sort((a, b) => a.fare - b.fare),
    }));

    return c.json({
      query: { from, to, travelDate: date ?? null },
      results,
    });
  }
);

// ────────────────────────────────────────────────────────────────────
// GET /api/trains/:id/availability?date=2027-01-15&from=NDLS&to=BCT
//
// Same numbers as search, for one train. `from`/`to` are optional; without
// them the whole run is priced.
// ────────────────────────────────────────────────────────────────────

trainRoutes.get(
  "/api/trains/:id/availability",
  zValidator("param", trainIdParamSchema),
  zValidator("query", availabilityQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { date, from, to } = c.req.valid("query");

    const train = await prisma.train.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        name: true,
        distanceKm: true,
        classes: { select: classSelect, orderBy: { classType: "asc" } },
        stops: { select: stopSelect, orderBy: { stopIndex: "asc" } },
      },
    });

    if (!train) {
      throw new HTTPException(404, { message: "Train not found" });
    }

    let segment: RouteSegment | null = null;

    if (from && to) {
      const byCode = await stationsByCode([from, to]);
      segment = resolveSegment(
        train.stops,
        byCode.get(from)!.id,
        byCode.get(to)!.id
      );

      if (!segment) {
        throw new HTTPException(400, {
          message: "Both stations must be on this train's route, in that order",
        });
      }
    } else {
      segment = resolveSegment(train.stops);
    }

    const distanceKm = segment?.distanceKm ?? train.distanceKm;
    const travelDate = parseTravelDate(date);

    const occupancy = await classOccupancy(
      train.classes.map((cls) => cls.id),
      travelDate
    );

    return c.json({
      train: { id: train.id, number: train.number, name: train.name },
      travelDate: date,
      segment: segment ? segmentView(segment) : null,
      distanceKm,
      classes: train.classes
        .map((cls) => classView(cls, distanceKm, occupancy))
        .sort((a, b) => a.fare - b.fare),
    });
  }
);
