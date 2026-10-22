/**
 * Train search, journey availability and station lookup.
 *
 * The route/journey split is what these tests protect:
 *
 *   Train   — A ──400km── B ────600km──── C   (fixed geometry)
 *   Schedule— runs daily at 06:00 IST, arrives 20:00 IST
 *   Journey — that train on 2026-11-01, with real departure/arrival instants
 *
 * Class: baseFare 100 + farePerKm 10 (paise), so:
 *   whole run A→C = 10100, segment A→B = 4100.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/db/client";
import { signAccessToken } from "../src/lib/jwt";

const RUN_ID = Math.random().toString(36).slice(2, 8);
let seq = 0;

const tracked = {
  stations: [] as string[],
  trains: [] as string[],
  users: [] as string[],
};

function code(prefix: string): string {
  seq += 1;
  return `${prefix}${RUN_ID}${seq}`.toUpperCase().slice(0, 20);
}

const BASE_FARE = 100;
const FARE_PER_KM = 10;
const TOTAL_DISTANCE = 1000;

/** 2026-11-01 is a Sunday; derive it rather than hard-coding. */
const TRAVEL_DATE = "2026-11-01";
const TRAVEL_DAY = new Date(`${TRAVEL_DATE}T00:00:00.000Z`).getUTCDay();

interface RouteOptions {
  /** Weekdays the train runs. Defaults to every day. */
  days?: number[];
  departTime?: string;
  arriveTime?: string;
  /** Skip the schedule entirely, to model a train with no timetable. */
  noSchedule?: boolean;
}

async function makeRoute(opts: RouteOptions = {}) {
  const a = await prisma.station.create({
    data: { code: code("A"), name: "Alpha", city: "Alpha City" },
  });
  const b = await prisma.station.create({
    data: { code: code("B"), name: "Beta", city: "Beta City" },
  });
  const c = await prisma.station.create({
    data: { code: code("C"), name: "Gamma", city: "Gamma City" },
  });

  const train = await prisma.train.create({
    data: {
      number: code("N"),
      name: "Route Express",
      originStationId: a.id,
      destStationId: c.id,
      distanceKm: TOTAL_DISTANCE,
    },
  });

  await prisma.trainStop.createMany({
    data: [
      {
        trainId: train.id,
        stationId: a.id,
        stopIndex: 0,
        distanceKm: 0,
        arrival: null,
        departure: "06:00",
      },
      {
        trainId: train.id,
        stationId: b.id,
        stopIndex: 1,
        distanceKm: 400,
        arrival: "11:00",
        departure: "11:10",
      },
      {
        trainId: train.id,
        stationId: c.id,
        stopIndex: 2,
        distanceKm: 1000,
        arrival: "20:00",
        departure: null,
      },
    ],
  });

  if (!opts.noSchedule) {
    const days = opts.days ?? [0, 1, 2, 3, 4, 5, 6];
    await prisma.trainSchedule.createMany({
      data: days.map((dayOfWeek) => ({
        trainId: train.id,
        dayOfWeek,
        runNumber: 1,
        departTime: opts.departTime ?? "06:00",
        arriveTime: opts.arriveTime ?? "20:00",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
      })),
    });
  }

  const cls = await prisma.trainClass.create({
    data: {
      trainId: train.id,
      classType: "SLEEPER",
      coachCount: 1,
      seatsPerCoach: 2,
      totalSeats: 2,
      baseFare: BASE_FARE,
      farePerKm: FARE_PER_KM,
    },
  });

  const seats = [];
  for (let i = 1; i <= 2; i++) {
    seats.push(
      await prisma.seat.create({
        data: {
          trainClassId: cls.id,
          coachNumber: 1,
          seatNumber: i,
          isAvailable: true,
        },
      })
    );
  }

  tracked.stations.push(a.id, b.id, c.id);
  tracked.trains.push(train.id);

  return { a, b, c, train, cls, seats };
}

async function makeUser() {
  const user = await prisma.user.create({
    data: {
      email: `train+${RUN_ID}+${randomUUID()}@example.test`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$placeholder",
      name: "Train Tester",
    },
  });
  tracked.users.push(user.id);
  return { user, token: await signAccessToken({ sub: user.id }) };
}

const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;

function get(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(path, { headers });
}

async function search(from: string, to: string, date?: string) {
  const query = new URLSearchParams({ from, to });
  if (date) query.set("date", date);
  const res = await get(`/api/v1/trains/search?${query.toString()}`);
  return { res, body: await json(res) };
}

afterAll(async () => {
  const trainIds = tracked.trains;

  if (trainIds.length) {
    const bookings = await prisma.booking.findMany({
      where: { trainId: { in: trainIds } },
      select: { id: true },
    });
    const bookingIds = bookings.map((b) => b.id);

    if (bookingIds.length) {
      await prisma.paymentEvent.deleteMany({
        where: { payment: { bookingId: { in: bookingIds } } },
      });
      await prisma.payment.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });
      await prisma.bookingSeat.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });
      await prisma.bookingPassenger.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }

    // JourneyClass and Journey cascade from Journey.
    await prisma.journey.deleteMany({ where: { trainId: { in: trainIds } } });
    await prisma.trainSchedule.deleteMany({
      where: { trainId: { in: trainIds } },
    });
    await prisma.seat.deleteMany({
      where: { trainClass: { trainId: { in: trainIds } } },
    });
    await prisma.trainClass.deleteMany({ where: { trainId: { in: trainIds } } });
    await prisma.trainStop.deleteMany({ where: { trainId: { in: trainIds } } });
    await prisma.train.deleteMany({ where: { id: { in: trainIds } } });
  }

  if (tracked.stations.length) {
    await prisma.station.deleteMany({
      where: { id: { in: tracked.stations } },
    });
  }
  if (tracked.users.length) {
    await prisma.user.deleteMany({ where: { id: { in: tracked.users } } });
  }

  await prisma.$disconnect();
});

// ────────────────────────────────────────────────────────────────────
// Stations
// ────────────────────────────────────────────────────────────────────

describe("GET /api/v1/stations", () => {
  test("finds a station by city, case-insensitively", async () => {
    const station = await prisma.station.create({
      data: {
        code: code("S"),
        name: `Test Junction ${RUN_ID}`,
        city: `Delhi ${RUN_ID}`,
        state: "Delhi",
      },
    });
    tracked.stations.push(station.id);

    const res = await get(
      `/api/v1/stations?search=delhi%20${RUN_ID.toLowerCase()}`
    );
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.count).toBe(1);
    expect(body.stations[0].id).toBe(station.id);
  }, 60_000);

  test("finds a station by code", async () => {
    const station = await prisma.station.create({
      data: { code: code("S"), name: `Code Lookup ${RUN_ID}`, city: "Nowhere" },
    });
    tracked.stations.push(station.id);

    const body = await json(await get(`/api/v1/stations?search=${station.code}`));
    expect(body.stations.map((s: any) => s.id)).toContain(station.id);
  }, 60_000);

  test("honours limit", async () => {
    const body = await json(await get(`/api/v1/stations?limit=1`));
    expect(body.stations).toHaveLength(1);
    expect(body.count).toBe(1);
  }, 60_000);

  test("rejects a bad limit with 400, not 500", async () => {
    const res = await get(`/api/v1/stations?limit=nope`);
    expect(res.status).toBe(400);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Search
// ────────────────────────────────────────────────────────────────────

describe("GET /api/v1/trains/search", () => {
  test("without a date: timetables and fares, no journey", async () => {
    const { a, b, train } = await makeRoute();

    const { res, body } = await search(a.code, b.code);
    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);

    const result = body.results[0];
    expect(result.train.id).toBe(train.id);
    expect(result.journey).toBeNull();
    expect(result.segment.distanceKm).toBe(400);
    expect(result.segment.from.stopIndex).toBe(0);
    expect(result.segment.to.stopIndex).toBe(1);
    expect(result.segment.durationMinutes).toBe(300); // 06:00 → 11:00

    const sleeper = result.classes[0];
    expect(sleeper.fare).toBe(4100); // not the 10100 whole-run fare
    expect(sleeper.availableSeats).toBeUndefined();
  }, 60_000);

  test("with a date: materialises a journey and live counts", async () => {
    const { a, b } = await makeRoute();

    const { body } = await search(a.code, b.code, TRAVEL_DATE);
    const result = body.results[0];

    expect(result.journey).not.toBeNull();
    expect(result.journey.date).toBe(TRAVEL_DATE);
    expect(result.journey.status).toBe("SCHEDULED");

    // 06:00 IST on 2026-11-01 is 00:30 UTC — not 06:00 UTC.
    expect(result.journey.departureAt).toBe("2026-11-01T00:30:00.000Z");
    // 20:00 IST is 14:30 UTC the same day.
    expect(result.journey.arrivalAt).toBe("2026-11-01T14:30:00.000Z");

    expect(result.classes[0].availableSeats).toBe(2);
    expect(result.classes[0].bookedSeats).toBe(0);
  }, 60_000);

  test("an overnight service arrives the next day", async () => {
    const { a, b } = await makeRoute({
      departTime: "21:10",
      arriveTime: "09:40",
    });

    const { body } = await search(a.code, b.code, TRAVEL_DATE);
    const journey = body.results[0].journey;

    // 21:10 IST on 1 Nov = 15:40 UTC on 1 Nov.
    expect(journey.departureAt).toBe("2026-11-01T15:40:00.000Z");
    // 09:40 IST on 2 Nov = 04:10 UTC on 2 Nov.
    expect(journey.arrivalAt).toBe("2026-11-02T04:10:00.000Z");
  }, 60_000);

  test("excluding trains that do not run on that weekday", async () => {
    const otherDay = (TRAVEL_DAY + 1) % 7;
    const { a, b } = await makeRoute({ days: [otherDay] });

    const sameDay = await search(a.code, b.code, TRAVEL_DATE);
    expect(sameDay.body.results).toHaveLength(0);

    // Same train, next day, is a result.
    const next = new Date(`${TRAVEL_DATE}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);

    const nextDay = await search(a.code, b.code, nextDate);
    expect(nextDay.body.results).toHaveLength(1);
  }, 60_000);

  test("a train with no schedule never appears for a dated search", async () => {
    const { a, b } = await makeRoute({ noSchedule: true });

    const undated = await search(a.code, b.code);
    expect(undated.body.results).toHaveLength(1);

    const dated = await search(a.code, b.code, TRAVEL_DATE);
    expect(dated.body.results).toHaveLength(0);
  }, 60_000);

  test("does not return a train running the other way", async () => {
    const { a, b } = await makeRoute();

    const { body } = await search(b.code, a.code, TRAVEL_DATE);
    expect(body.results).toHaveLength(0);
  }, 60_000);

  test("station codes are case-insensitive", async () => {
    const { a, b } = await makeRoute();

    const { res, body } = await search(
      a.code.toLowerCase(),
      b.code.toLowerCase()
    );
    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
  }, 60_000);

  test("repeated searches reuse the same journey", async () => {
    const { a, b } = await makeRoute();

    const first = await search(a.code, b.code, TRAVEL_DATE);
    const second = await search(a.code, b.code, TRAVEL_DATE);

    expect(first.body.results[0].journey.id).toBe(
      second.body.results[0].journey.id
    );

    const journeyId = first.body.results[0].journey.id;
    const count = await prisma.journey.count({ where: { id: journeyId } });
    expect(count).toBe(1);

    const classes = await prisma.journeyClass.count({
      where: { journeyId },
    });
    expect(classes).toBe(1); // one class on this fixture, snapshotted once
  }, 60_000);

  test("rejects an unknown station code with 404", async () => {
    const res = await get(`/api/v1/trains/search?from=NOPE1&to=NOPE2`);
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toContain("NOPE1");
  }, 60_000);

  test("rejects from == to", async () => {
    const res = await get(`/api/v1/trains/search?from=NDLS&to=NDLS`);
    expect(res.status).toBe(400);
  }, 60_000);

  test("rejects a malformed date", async () => {
    const { a, b } = await makeRoute();
    const res = await get(
      `/api/v1/trains/search?from=${a.code}&to=${b.code}&date=2026-13-40`
    );
    expect(res.status).toBe(400);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Availability
// ────────────────────────────────────────────────────────────────────

describe("GET /api/v1/journeys/:journeyId/availability", () => {
  test("prices the whole run by default", async () => {
    const { a, b } = await makeRoute();
    const { body } = await search(a.code, b.code, TRAVEL_DATE);
    const journeyId = body.results[0].journey.id;

    const res = await get(`/api/v1/journeys/${journeyId}/availability`);
    expect(res.status).toBe(200);

    const availability = await json(res);
    expect(availability.journey.id).toBe(journeyId);
    expect(availability.distanceKm).toBe(1000);
    expect(availability.segment.from.stopIndex).toBe(0);
    expect(availability.segment.to.stopIndex).toBe(2);
    expect(availability.classes[0].fare).toBe(10100);
    expect(availability.classes[0].availableSeats).toBe(2);
  }, 60_000);

  test("prices a segment when from/to are given", async () => {
    const { a, b, c } = await makeRoute();
    const { body } = await search(a.code, c.code, TRAVEL_DATE);
    const journeyId = body.results[0].journey.id;

    const res = await get(
      `/api/v1/journeys/${journeyId}/availability?from=${a.code}&to=${b.code}`
    );
    expect(res.status).toBe(200);

    const availability = await json(res);
    expect(availability.distanceKm).toBe(400);
    expect(availability.classes[0].fare).toBe(4100);
    expect(availability.segment.from.code).toBe(a.code);
    expect(availability.segment.to.code).toBe(b.code);
  }, 60_000);

  test("rejects a station the journey does not serve", async () => {
    const { a, c } = await makeRoute();
    const { body } = await search(a.code, c.code, TRAVEL_DATE);
    const journeyId = body.results[0].journey.id;

    const res = await get(
      `/api/v1/journeys/${journeyId}/availability?from=${a.code}&to=NDLS`
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("rejects from without to", async () => {
    const { a, b } = await makeRoute();
    const { body } = await search(a.code, b.code, TRAVEL_DATE);
    const journeyId = body.results[0].journey.id;

    const res = await get(
      `/api/v1/journeys/${journeyId}/availability?from=${a.code}`
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("unknown journey id is 404", async () => {
    const res = await get(`/api/v1/journeys/${randomUUID()}/availability`);
    expect(res.status).toBe(404);
  }, 60_000);

  test("availability drops when a seat is held, and only for that journey", async () => {
    const { a, b, train, seats } = await makeRoute();
    const { token } = await makeUser();

    const { body } = await search(a.code, b.code, TRAVEL_DATE);
    const journeyId = body.results[0].journey.id;

    const booking = await app.request("/api/bookings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${seq % 250}.1.1`,
      },
      body: JSON.stringify({
        trainId: train.id,
        travelDate: TRAVEL_DATE,
        fromStopIndex: 0,
        toStopIndex: 1,
        passengers: [
          { name: "Asha", age: 31, gender: "FEMALE", seatId: seats[0]!.id },
        ],
      }),
    });
    expect(booking.status).toBe(201);

    const after = await json(
      await get(`/api/v1/journeys/${journeyId}/availability`)
    );
    expect(after.classes[0].bookedSeats).toBe(1);
    expect(after.classes[0].availableSeats).toBe(1);

    // A different date creates a different journey with its own inventory.
    const otherDate = await search(a.code, b.code, "2026-11-02");
    const otherJourneyId = otherDate.body.results[0].journey.id;

    const other = await json(
      await get(`/api/v1/journeys/${otherJourneyId}/availability`)
    );
    expect(other.classes[0].availableSeats).toBe(2);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Search and booking must agree on money
// ────────────────────────────────────────────────────────────────────

describe("segment fare consistency", () => {
  test("booking a segment charges exactly what search quoted", async () => {
    const { a, b, train, seats } = await makeRoute();
    const { token } = await makeUser();

    const { body } = await search(a.code, b.code, TRAVEL_DATE);
    const result = body.results[0];
    const quoted = result.classes[0].fare;

    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${seq % 250}.1.2`,
      },
      body: JSON.stringify({
        trainId: train.id,
        travelDate: TRAVEL_DATE,
        fromStopIndex: result.segment.from.stopIndex,
        toStopIndex: result.segment.to.stopIndex,
        passengers: [
          { name: "Asha", age: 31, gender: "FEMALE", seatId: seats[0]!.id },
        ],
      }),
    });

    expect(res.status).toBe(201);

    const { booking } = await json(res);
    expect(booking.totalAmount).toBe(quoted);
    expect(booking.totalAmount).toBe(4100);
    expect(booking.fromStopIndex).toBe(0);
    expect(booking.toStopIndex).toBe(1);
  }, 60_000);

  test("the unversioned /api alias still serves search", async () => {
    const { a, b } = await makeRoute();
    const res = await get(`/api/trains/search?from=${a.code}&to=${b.code}`);
    expect(res.status).toBe(200);
    expect((await json(res)).results).toHaveLength(1);
  }, 60_000);
});
