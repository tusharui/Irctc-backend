/**
 * Train search + availability HTTP tests.
 *
 * These cover the part of the system that answers "is there a train, what
 * does it cost, and how many seats are left" — before any money or locks are
 * involved. The fare assertions are the important ones: a search result that
 * quotes a Delhi → Bhopal price while the booking endpoint charges the
 * Delhi → Chennai price is worse than no search at all.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/db/client";
import { signAccessToken } from "../src/lib/jwt";

// ────────────────────────────────────────────────────────────────────
// Fixtures
//
// Route: A ---400km--- B ---------600km--------- C   (1000km total)
// Class: baseFare 100, farePerKm 10 (paise)
//   whole run  = 100 + 10 * 1000 = 10100
//   A -> B     = 100 + 10 *  400 =  4100
// ────────────────────────────────────────────────────────────────────

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

async function makeRoute() {
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
      startTime: "06:00",
      endTime: "20:00",
      distanceKm: TOTAL_DISTANCE,
    },
  });

  await prisma.trainStop.createMany({
    data: [
      { trainId: train.id, stationId: a.id, stopIndex: 0, distanceKm: 0, arrival: null, departure: "06:00" },
      { trainId: train.id, stationId: b.id, stopIndex: 1, distanceKm: 400, arrival: "11:00", departure: "11:10" },
      { trainId: train.id, stationId: c.id, stopIndex: 2, distanceKm: 1000, arrival: "20:00", departure: null },
    ],
  });

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
        data: { trainClassId: cls.id, coachNumber: 1, seatNumber: i, isAvailable: true },
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

const json = async <T = any>(res: Response): Promise<T> =>
  (await res.json()) as T;

function get(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(path, { headers });
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
      await prisma.paymentEvent.deleteMany({ where: { payment: { bookingId: { in: bookingIds } } } });
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingSeat.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingPassenger.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    await prisma.seat.deleteMany({ where: { trainClass: { trainId: { in: trainIds } } } });
    await prisma.trainClass.deleteMany({ where: { trainId: { in: trainIds } } });
    await prisma.trainStop.deleteMany({ where: { trainId: { in: trainIds } } });
    await prisma.train.deleteMany({ where: { id: { in: trainIds } } });
  }
  if (tracked.stations.length) {
    await prisma.station.deleteMany({ where: { id: { in: tracked.stations } } });
  }
  if (tracked.users.length) {
    await prisma.user.deleteMany({ where: { id: { in: tracked.users } } });
  }
  await prisma.$disconnect();
});

// ────────────────────────────────────────────────────────────────────
// Search
// ────────────────────────────────────────────────────────────────────

describe("GET /api/trains/search", () => {
  test("finds a train and prices the segment, not the whole run", async () => {
    const { a, b, train } = await makeRoute();

    const res = await get(`/api/trains/search?from=${a.code}&to=${b.code}`);
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.results).toHaveLength(1);

    const result = body.results[0];
    expect(result.train.id).toBe(train.id);
    expect(result.from.code).toBe(a.code);
    expect(result.to.code).toBe(b.code);
    expect(result.segment.distanceKm).toBe(400);
    expect(result.segment.fromStopIndex).toBe(0);
    expect(result.segment.toStopIndex).toBe(1);

    const sleeper = result.classes.find((cls: any) => cls.classType === "SLEEPER");
    // 100 + 10 * 400 — NOT 10100, which the whole-run fare would be.
    expect(sleeper.fare).toBe(4100);
    expect(sleeper.availableSeats).toBeUndefined();

    // 06:00 -> 11:00
    expect(result.segment.durationMinutes).toBe(300);
  }, 60_000);

  test("station codes are case-insensitive", async () => {
    const { a, b } = await makeRoute();

    const res = await get(
      `/api/trains/search?from=${a.code.toLowerCase()}&to=${b.code.toLowerCase()}`
    );

    expect(res.status).toBe(200);
    expect((await json(res)).results).toHaveLength(1);
  }, 60_000);

  test("does not return a train running the other way", async () => {
    const { a, b } = await makeRoute();

    // B -> A is not served: the train only stops at B after A.
    const res = await get(`/api/trains/search?from=${b.code}&to=${a.code}`);
    expect(res.status).toBe(200);
    expect((await json(res)).results).toHaveLength(0);
  }, 60_000);

  test("an overnight leg reports a sensible duration", async () => {
    const { b, c } = await makeRoute();

    // 11:10 -> 20:00 = 8h50m
    const res = await get(`/api/trains/search?from=${b.code}&to=${c.code}`);
    const body = await json(res);

    expect(body.results[0].segment.durationMinutes).toBe(530);
  }, 60_000);

  test("rejects an unknown station code with 404", async () => {
    const res = await get(`/api/trains/search?from=NOPE1&to=NOPE2&date=2027-01-01`);
    expect(res.status).toBe(404);

    const body = await json(res);
    expect(body.error.message).toContain("NOPE1");
  }, 60_000);

  test("rejects from == to", async () => {
    const res = await get(`/api/trains/search?from=NDLS&to=NDLS`);
    expect(res.status).toBe(400);
  }, 60_000);

  test("rejects a malformed date", async () => {
    const { a, b } = await makeRoute();
    const res = await get(
      `/api/trains/search?from=${a.code}&to=${b.code}&date=2027-13-40`
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("with a date, availability drops when a seat is held", async () => {
    const { a, b, train, seats } = await makeRoute();
    const { token } = await makeUser();

    const before = await json(
      await get(`/api/trains/search?from=${a.code}&to=${b.code}&date=2027-07-01`)
    );
    expect(before.results[0].classes[0].availableSeats).toBe(2);

    const booking = await app.request("/api/bookings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${seq % 250}.0.1`,
      },
      body: JSON.stringify({
        trainId: train.id,
        travelDate: "2027-07-01",
        passengers: [
          { name: "Asha", age: 31, gender: "FEMALE", seatId: seats[0]!.id },
        ],
      }),
    });
    expect(booking.status).toBe(201);

    const after = await json(
      await get(`/api/trains/search?from=${a.code}&to=${b.code}&date=2027-07-01`)
    );
    expect(after.results[0].classes[0].availableSeats).toBe(1);
    expect(after.results[0].classes[0].bookedSeats).toBe(1);

    // A different date is unaffected: occupancy is per travel date.
    const otherDay = await json(
      await get(`/api/trains/search?from=${a.code}&to=${b.code}&date=2027-07-02`)
    );
    expect(otherDay.results[0].classes[0].availableSeats).toBe(2);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Availability
// ────────────────────────────────────────────────────────────────────

describe("GET /api/trains/:id/availability", () => {
  test("prices the whole run when no segment is given", async () => {
    const { train } = await makeRoute();

    const res = await get(`/api/trains/${train.id}/availability?date=2027-08-01`);
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.segment.fromStopIndex).toBe(0);
    expect(body.segment.toStopIndex).toBe(2);
    expect(body.distanceKm).toBe(1000);
    expect(body.classes[0].fare).toBe(10100);
    expect(body.classes[0].availableSeats).toBe(2);
  }, 60_000);

  test("prices a segment when from/to are given", async () => {
    const { a, b, train } = await makeRoute();

    const res = await get(
      `/api/trains/${train.id}/availability?date=2027-08-01&from=${a.code}&to=${b.code}`
    );
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.distanceKm).toBe(400);
    expect(body.classes[0].fare).toBe(4100);
  }, 60_000);

  test("rejects a station the train does not serve", async () => {
    const { a, train } = await makeRoute();

    // NDLS comes from the seeded data and is not on this test train.
    const res = await get(
      `/api/trains/${train.id}/availability?date=2027-08-01&from=${a.code}&to=NDLS`
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("rejects from/to supplied without their pair", async () => {
    const { a, train } = await makeRoute();

    const res = await get(
      `/api/trains/${train.id}/availability?date=2027-08-01&from=${a.code}`
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("unknown train id gets 404", async () => {
    const res = await get(
      `/api/trains/${randomUUID()}/availability?date=2027-08-01`
    );
    expect(res.status).toBe(404);
  }, 60_000);

  test("requires a date", async () => {
    const { train } = await makeRoute();
    const res = await get(`/api/trains/${train.id}/availability`);
    expect(res.status).toBe(400);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Search and booking must agree on money
// ────────────────────────────────────────────────────────────────────

describe("segment fare consistency", () => {
  test("booking a segment charges exactly what search quoted", async () => {
    const { a, b, train, seats } = await makeRoute();
    const { token } = await makeUser();

    const search = await json(
      await get(`/api/trains/search?from=${a.code}&to=${b.code}&date=2027-09-01`)
    );
    const quoted = search.results[0].classes[0].fare;

    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${seq % 250}.0.2`,
      },
      body: JSON.stringify({
        trainId: train.id,
        travelDate: "2027-09-01",
        fromStopIndex: search.results[0].segment.fromStopIndex,
        toStopIndex: search.results[0].segment.toStopIndex,
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

  test("a stop index that is not on the route is refused", async () => {
    const { train, seats } = await makeRoute();
    const { token } = await makeUser();

    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${seq % 250}.0.3`,
      },
      body: JSON.stringify({
        trainId: train.id,
        travelDate: "2027-09-02",
        fromStopIndex: 0,
        toStopIndex: 99,
        passengers: [
          { name: "Asha", age: 31, gender: "FEMALE", seatId: seats[0]!.id },
        ],
      }),
    });

    expect(res.status).toBe(400);
  }, 60_000);

  test("reversed stop indices are refused", async () => {
    const { train, seats } = await makeRoute();
    const { token } = await makeUser();

    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.${seq % 250}.0.4`,
      },
      body: JSON.stringify({
        trainId: train.id,
        travelDate: "2027-09-03",
        fromStopIndex: 2,
        toStopIndex: 1,
        passengers: [
          { name: "Asha", age: 31, gender: "FEMALE", seatId: seats[0]!.id },
        ],
      }),
    });

    expect(res.status).toBe(400);
  }, 60_000);
});
