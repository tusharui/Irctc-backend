
import { prisma } from "../../db/client";
import { isUniqueViolation } from "../../db/errors";

/** Indian Railways runs on IST (UTC+05:30). Timetable strings are wall clock. */
const IST_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Clock {
  hours: number;
  minutes: number;
}

export function parseClock(value: string): Clock | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

/**
 * A wall-clock time on a service date, as a real instant.
 *
 * `date` is UTC midnight of the *service* date, matching the DATE column.
 * 06:00 IST on 2026-11-01 is 00:30 UTC on 2026-11-01 — not 06:00 UTC.
 */
export function istInstant(date: Date, clock: string, dayOffset = 0): Date {
  const parsed = parseClock(clock);
  if (!parsed) {
    throw new Error(`Invalid timetable value: ${JSON.stringify(clock)}`);
  }

  const midnightUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );

  return new Date(
    midnightUtc +
      dayOffset * DAY_MS +
      (parsed.hours * 60 + parsed.minutes - IST_OFFSET_MINUTES) * 60_000
  );
}

/**
 * Departure and arrival instants for a schedule on a date.
 *
 * An arrival that is not after the departure means the train ran past
 * midnight: 21:10 → 09:40 is the next morning, not negative eleven hours.
 */
export function scheduleInstants(
  date: Date,
  departTime: string,
  arriveTime: string
): { departureAt: Date; arrivalAt: Date } {
  const departureAt = istInstant(date, departTime);
  let arrivalAt = istInstant(date, arriveTime);

  if (arrivalAt.getTime() <= departureAt.getTime()) {
    arrivalAt = istInstant(date, arriveTime, 1);
  }

  return { departureAt, arrivalAt };
}

export type JourneyRow = Awaited<
  ReturnType<typeof prisma.journey.findMany>
>[number];

/**
 * Get-or-create the journeys for `trainIds` on `date`.
 *
 * Returns a map keyed by train id. A train that does not run on that weekday
 * (or whose timetable has expired) is simply absent — the caller drops it from
 * search results rather than inventing a service.
 */
export async function ensureJourneys(
  trainIds: string[],
  date: Date
): Promise<Map<string, JourneyRow>> {
  const result = new Map<string, JourneyRow>();

  if (trainIds.length === 0) return result;

  const dayOfWeek = date.getUTCDay();

  const schedules = await prisma.trainSchedule.findMany({
    where: {
      trainId: { in: trainIds },
      dayOfWeek,
      isActive: true,
      validFrom: { lte: date },
      OR: [{ validTo: null }, { validTo: { gte: date } }],
    },
    orderBy: { runNumber: "asc" },
  });

  // One journey per train for now: the earliest run of the day. Multiple runs
  // per day are modelled (`runNumber`) but not yet surfaced in search.
  const scheduleByTrain = new Map<
    string,
    (typeof schedules)[number]
  >();
  for (const schedule of schedules) {
    if (!scheduleByTrain.has(schedule.trainId)) {
      scheduleByTrain.set(schedule.trainId, schedule);
    }
  }

  if (scheduleByTrain.size === 0) return result;

  const activeTrainIds = [...scheduleByTrain.keys()];

  const existing = await prisma.journey.findMany({
    where: { trainId: { in: activeTrainIds }, date },
  });
  const existingKeys = new Set(
    existing.map((journey) => `${journey.trainId}:${journey.runNumber}`)
  );

  const missing: {
    trainId: string;
    trainScheduleId: string;
    runNumber: number;
    date: Date;
    departureAt: Date;
    arrivalAt: Date;
  }[] = [];

  for (const [trainId, schedule] of scheduleByTrain) {
    if (existingKeys.has(`${trainId}:${schedule.runNumber}`)) continue;

    const { departureAt, arrivalAt } = scheduleInstants(
      date,
      schedule.departTime,
      schedule.arriveTime
    );

    missing.push({
      trainId,
      trainScheduleId: schedule.id,
      runNumber: schedule.runNumber,
      date,
      departureAt,
      arrivalAt,
    });
  }

  if (missing.length > 0) {
    try {
      await prisma.journey.createMany({ data: missing, skipDuplicates: true });
    } catch (error) {
      // A concurrent search may have created the same journey between our read
      // and write. `skipDuplicates` covers the common case; a racing unique
      // violation is equally harmless because the row now exists, which is all
      // we need. Anything else is real.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  const journeys = await prisma.journey.findMany({
    where: { trainId: { in: activeTrainIds }, date },
    orderBy: { runNumber: "asc" },
  });

  await ensureJourneyClasses(journeys.map((journey) => journey.id));

  for (const journey of journeys) {
    if (!result.has(journey.trainId)) {
      result.set(journey.trainId, journey);
    }
  }

  return result;
}

/**
 * Snapshot `TrainClass` rows onto a journey, once.
 *
 * The copy is the point: editing a fare for next month must not reprice a
 * journey already on sale, and deleting a class must not corrupt past journeys.
 */
async function ensureJourneyClasses(journeyIds: string[]): Promise<void> {
  if (journeyIds.length === 0) return;

  const journeys = await prisma.journey.findMany({
    where: { id: { in: journeyIds } },
    select: { id: true, trainId: true },
  });

  const existing = await prisma.journeyClass.findMany({
    where: { journeyId: { in: journeyIds } },
    select: { journeyId: true, trainClassId: true },
  });
  const existingKeys = new Set(
    existing.map((row) => `${row.journeyId}:${row.trainClassId}`)
  );

  const trainIds = [...new Set(journeys.map((journey) => journey.trainId))];
  const trainClasses = await prisma.trainClass.findMany({
    where: { trainId: { in: trainIds } },
  });

  const rows: {
    journeyId: string;
    trainClassId: string;
    classType: (typeof trainClasses)[number]["classType"];
    coachCount: number;
    seatsPerCoach: number;
    totalSeats: number;
    baseFare: number;
    farePerKm: number;
  }[] = [];

  for (const journey of journeys) {
    for (const cls of trainClasses) {
      if (cls.trainId !== journey.trainId) continue;
      if (existingKeys.has(`${journey.id}:${cls.id}`)) continue;

      rows.push({
        journeyId: journey.id,
        trainClassId: cls.id,
        classType: cls.classType,
        coachCount: cls.coachCount,
        seatsPerCoach: cls.seatsPerCoach,
        totalSeats: cls.totalSeats,
        baseFare: cls.baseFare,
        farePerKm: cls.farePerKm,
      });
    }
  }

  if (rows.length === 0) return;

  try {
    await prisma.journeyClass.createMany({ data: rows, skipDuplicates: true });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/** Full journey for the availability endpoint: route, classes, status. */
export function findJourney(journeyId: string) {
  return prisma.journey.findUnique({
    where: { id: journeyId },
    select: {
      id: true,
      date: true,
      runNumber: true,
      status: true,
      departureAt: true,
      arrivalAt: true,
      train: {
        select: {
          id: true,
          number: true,
          name: true,
          distanceKm: true,
          originStation: { select: { code: true, name: true } },
          destStation: { select: { code: true, name: true } },
          stops: {
            select: {
              stationId: true,
              stopIndex: true,
              distanceKm: true,
              arrival: true,
              departure: true,
              station: { select: { code: true, name: true } },
            },
            orderBy: { stopIndex: "asc" },
          },
        },
      },
      classes: {
        select: {
          id: true,
          trainClassId: true,
          classType: true,
          coachCount: true,
          seatsPerCoach: true,
          totalSeats: true,
          baseFare: true,
          farePerKm: true,
        },
        orderBy: { classType: "asc" },
      },
    },
  });
}
