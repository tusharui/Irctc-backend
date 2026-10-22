
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";
import { zValidator } from "../../lib/validation";
import type { AuthVariables } from "../../middleware/auth";
import { parseTravelDate } from "../booking/booking.schemas";
import { seatFare } from "../booking/reservation.service";
import {
  ensureJourneys,
  findJourney,
  type JourneyRow,
} from "../journey/journey.service";
import {
  journeyAvailabilityQuerySchema,
  journeyIdParamSchema,
  searchTrainsQuerySchema,
} from "./train.schemas";
import {
  availableSeats,
  classOccupancy,
  resolveSegment,
  type ClassOccupancy,
  type RouteSegment,
  type StopRow,
} from "./train.service";

export const trainRoutes = new Hono<{ Variables: AuthVariables }>();

// ────────────────────────────────────────────────────────────────────
// Shapes
// ────────────────────────────────────────────────────────────────────

/**
 * A class as the API exposes it. `occupancyKey` is the `TrainClass` id in both
 * cases: journey classes reference it, so bookings (which are keyed by
 * trainClassId) count against the right row without joining through the
 * journey.
 */
interface ClassSnapshot {
  occupancyKey: string;
  classType: string;
  coachCount: number;
  seatsPerCoach: number;
  totalSeats: number;
  baseFare: number;
  farePerKm: number;
}

const trainClassSelect = {
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

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function journeySummary(journey: {
  id: string;
  date: Date;
  runNumber: number;
  status: string;
  departureAt: Date;
  arrivalAt: Date;
}) {
  return {
    id: journey.id,
    date: formatDate(journey.date),
    runNumber: journey.runNumber,
    status: journey.status,
    departureAt: journey.departureAt,
    arrivalAt: journey.arrivalAt,
  };
}

/**
 * One class, priced for the segment and — when a date was supplied — with live
 * counts. `availableSeats` is derived on every read, never stored.
 */
function classView(
  cls: ClassSnapshot,
  distanceKm: number,
  occupancy: Map<string, ClassOccupancy> | null
) {
  const base = {
    classType: cls.classType,
    coachCount: cls.coachCount,
    seatsPerCoach: cls.seatsPerCoach,
    totalSeats: cls.totalSeats,
    fare: seatFare(cls, distanceKm),
  };

  if (!occupancy) return base;

  const occ = occupancy.get(cls.occupancyKey);
  return {
    ...base,
    bookedSeats: occ?.bookedSeats ?? 0,
    blockedSeats: occ?.blockedSeats ?? 0,
    availableSeats: availableSeats(cls.totalSeats, occ),
  };
}

function segmentView(
  segment: RouteSegment,
  from: { code: string; name: string },
  to: { code: string; name: string }
) {
  return {
    from: {
      code: from.code,
      name: from.name,
      stopIndex: segment.from.stopIndex,
      departure: segment.from.departure,
      distanceKm: segment.from.distanceKm,
    },
    to: {
      code: to.code,
      name: to.name,
      stopIndex: segment.to.stopIndex,
      arrival: segment.to.arrival,
      distanceKm: segment.to.distanceKm,
    },
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

/** Look up station names for the endpoints of a segment. */
function stationsAt(stops: { stopIndex: number; station: { code: string; name: string } }[], segment: RouteSegment) {
  const at = (stopIndex: number) => {
    const stop = stops.find((row) => row.stopIndex === stopIndex);
    return stop?.station ?? { code: "?", name: "?" };
  };

  return { from: at(segment.from.stopIndex), to: at(segment.to.stopIndex) };
}

// ────────────────────────────────────────────────────────────────────
// GET /trains/search?from=NDLS&to=JP&date=2026-11-01
//
// A train matches when its route visits both stations in that order. With a
// date, only trains that actually run that weekday are returned, and each
// result carries the materialised `journey` the client books against.
// ────────────────────────────────────────────────────────────────────

trainRoutes.get(
  "/trains/search",
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
        classes: { select: trainClassSelect, orderBy: { classType: "asc" } },
        stops: { select: stopSelect, orderBy: { stopIndex: "asc" } },
      },
      orderBy: { number: "asc" },
    });

    // Prisma cannot express "stop A comes before stop B on the same train"
    // without a self-join, so the ordering check runs over the fetched route.
    const matched = trains.flatMap((train) => {
      const segment = resolveSegment(
        train.stops,
        fromStation.id,
        toStation.id
      );
      return segment ? [{ train, segment }] : [];
    });

    let journeys = new Map<string, JourneyRow>();
    if (travelDate) {
      journeys = await ensureJourneys(
        matched.map(({ train }) => train.id),
        travelDate
      );
    }

    // With a date, a train that does not run that day is not a result.
    const rows = travelDate
      ? matched.filter(({ train }) => journeys.has(train.id))
      : matched;

    const journeyClasses = travelDate
      ? await prisma.journeyClass.findMany({
          where: {
            journeyId: { in: rows.map(({ train }) => journeys.get(train.id)!.id) },
          },
          select: {
            journeyId: true,
            trainClassId: true,
            classType: true,
            coachCount: true,
            seatsPerCoach: true,
            totalSeats: true,
            baseFare: true,
            farePerKm: true,
          },
          orderBy: { classType: "asc" },
        })
      : [];

    const classesByJourney = new Map<string, ClassSnapshot[]>();
    for (const cls of journeyClasses) {
      const list = classesByJourney.get(cls.journeyId) ?? [];
      list.push({
        occupancyKey: cls.trainClassId,
        classType: cls.classType,
        coachCount: cls.coachCount,
        seatsPerCoach: cls.seatsPerCoach,
        totalSeats: cls.totalSeats,
        baseFare: cls.baseFare,
        farePerKm: cls.farePerKm,
      });
      classesByJourney.set(cls.journeyId, list);
    }

    const occupancy = travelDate
      ? await classOccupancy(
          rows.flatMap(({ train }) => {
            const journey = journeys.get(train.id)!;
            return (classesByJourney.get(journey.id) ?? []).map(
              (cls) => cls.occupancyKey
            );
          }),
          travelDate
        )
      : null;

    const results = rows.map(({ train, segment }) => {
      const journey = journeys.get(train.id) ?? null;
      const classes: ClassSnapshot[] = journey
        ? classesByJourney.get(journey.id) ?? []
        : train.classes.map((cls) => ({
            occupancyKey: cls.id,
            classType: cls.classType,
            coachCount: cls.coachCount,
            seatsPerCoach: cls.seatsPerCoach,
            totalSeats: cls.totalSeats,
            baseFare: cls.baseFare,
            farePerKm: cls.farePerKm,
          }));

      return {
        journey: journey ? journeySummary(journey) : null,
        train: { id: train.id, number: train.number, name: train.name },
        segment: segmentView(
          segment,
          { code: fromStation.code, name: fromStation.name },
          { code: toStation.code, name: toStation.name }
        ),
        classes: classes
          .map((cls) => classView(cls, segment.distanceKm, occupancy))
          .sort((a, b) => a.fare - b.fare),
      };
    });

    return c.json({
      query: { from, to, travelDate: date ?? null },
      results,
    });
  }
);

// ────────────────────────────────────────────────────────────────────
// GET /journeys/:journeyId/availability[?from=NDLS&to=JP]
//
// Availability for one dated service. `from`/`to` narrow the price to a
// segment; counts stay per class because a booking currently holds its seat
// for the whole date (conservative, never oversells).
// ────────────────────────────────────────────────────────────────────

trainRoutes.get(
  "/journeys/:journeyId/availability",
  zValidator("param", journeyIdParamSchema),
  zValidator("query", journeyAvailabilityQuerySchema),
  async (c) => {
    const { journeyId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");

    const journey = await findJourney(journeyId);
    if (!journey) {
      throw new HTTPException(404, { message: "Journey not found" });
    }

    const stops = journey.train.stops satisfies (StopRow & {
      station: { code: string; name: string };
    })[];

    let segment: RouteSegment | null = null;

    if (from && to) {
      const byCode = await stationsByCode([from, to]);
      segment = resolveSegment(
        stops,
        byCode.get(from)!.id,
        byCode.get(to)!.id
      );

      if (!segment) {
        throw new HTTPException(400, {
          message: "Both stations must be on this train's route, in that order",
        });
      }
    } else {
      segment = resolveSegment(stops);
    }

    const distanceKm = segment?.distanceKm ?? journey.train.distanceKm;

    const occupancy = await classOccupancy(
      journey.classes.map((cls) => cls.trainClassId),
      journey.date
    );

    const endpoints = segment
      ? stationsAt(journey.train.stops, segment)
      : {
          from: journey.train.originStation,
          to: journey.train.destStation,
        };

    return c.json({
      journey: journeySummary(journey),
      train: {
        id: journey.train.id,
        number: journey.train.number,
        name: journey.train.name,
        origin: journey.train.originStation,
        destination: journey.train.destStation,
      },
      segment: segment
        ? segmentView(segment, endpoints.from, endpoints.to)
        : null,
      distanceKm,
      classes: journey.classes
        .map((cls) =>
          classView(
            {
              occupancyKey: cls.trainClassId,
              classType: cls.classType,
              coachCount: cls.coachCount,
              seatsPerCoach: cls.seatsPerCoach,
              totalSeats: cls.totalSeats,
              baseFare: cls.baseFare,
              farePerKm: cls.farePerKm,
            },
            distanceKm,
            occupancy
          )
        )
        .sort((a, b) => a.fare - b.fare),
    });
  }
);
