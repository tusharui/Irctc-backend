/**
 * Booking + payment HTTP integration tests.
 *
 * These drive the real Hono app (`app.request`), the real Prisma client and
 * the real Neon database. Nothing is mocked: the interesting behaviour lives
 * at the boundary between HTTP, the reservation transaction and Postgres
 * constraints.
 *
 * What is covered:
 *   * creating a hold, with the fare computed server-side
 *   * concurrent requests for the same seat
 *   * ownership boundaries on read / cancel / pay
 *   * idempotent payment opening
 *   * signed webhooks, replays, and bad signatures
 *   * the admin sweeper endpoint
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "../src/db/client";
import { env } from "../src/env";
import { signAccessToken } from "../src/lib/jwt";
import { signWebhook } from "../src/lib/webhook-signature";

// ────────────────────────────────────────────────────────────────────
// Fixtures
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

async function makeTrain(opts: { seats?: number; distanceKm?: number } = {}) {
  const s1 = await prisma.station.create({
    data: { code: code("F"), name: "From", city: "From City" },
  });
  const s2 = await prisma.station.create({
    data: { code: code("T"), name: "To", city: "To City" },
  });

  const distanceKm = opts.distanceKm ?? 500;
  const train = await prisma.train.create({
    data: {
      number: code("N"),
      name: "API Express",
      originStationId: s1.id,
      destStationId: s2.id,
      distanceKm,
    },
  });

  const seatCount = opts.seats ?? 1;
  const cls = await prisma.trainClass.create({
    data: {
      trainId: train.id,
      classType: "SLEEPER",
      coachCount: 1,
      seatsPerCoach: seatCount,
      totalSeats: seatCount,
      // Fare per seat = baseFare + farePerKm * distanceKm = 100 + 10*500 = 5100
      farePerKm: 10,
      baseFare: 100,
    },
  });

  const seats = [];
  for (let i = 1; i <= seatCount; i++) {
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

  tracked.stations.push(s1.id, s2.id);
  tracked.trains.push(train.id);

  return { train, cls, seats, distanceKm };
}

async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
  const user = await prisma.user.create({
    data: {
      email: `api+${RUN_ID}+${randomUUID()}@example.test`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$placeholder",
      name: "API Tester",
      role,
    },
  });
  tracked.users.push(user.id);
  const token = await signAccessToken({ sub: user.id });
  return { user, token };
}

/** Distinct source IP per request so the rate limiter never interferes. */
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq & 255) || 1}`;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send an exact raw body (needed for webhook signatures). */
  rawBody?: string;
}

function call(path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    "x-forwarded-for": nextIp(),
    ...options.headers,
  };

  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers["content-type"] ??= "application/json";
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }

  return app.request(path, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
}

const json = async <T = any>(res: Response): Promise<T> =>
  (await res.json()) as T;

const passengerFor = (seatId: string) => ({
  name: "Asha Verma",
  age: 31,
  gender: "FEMALE" as const,
  berthPreference: "LOWER",
  seatId,
});

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
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingSeat.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingPassenger.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    await prisma.seat.deleteMany({ where: { trainClass: { trainId: { in: trainIds } } } });
    await prisma.trainClass.deleteMany({ where: { trainId: { in: trainIds } } });
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
// POST /api/bookings
// ────────────────────────────────────────────────────────────────────

describe("POST /api/bookings", () => {
  test("creates a PENDING hold and returns a server-computed fare", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const res = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-01-15",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });

    expect(res.status).toBe(201);

    const { booking } = await json(res);

    expect(booking.status).toBe("PENDING");
    expect(booking.pnr).toHaveLength(10);
    expect(booking.travelDate.slice(0, 10)).toBe("2027-01-15");
    // 100 base + 10/paise-per-km * 500 km = 5100 paise per seat.
    expect(booking.totalAmount).toBe(5100);
    expect(booking.passengers).toHaveLength(1);
    expect(booking.seats).toHaveLength(1);
    expect(booking.holdExpiresAt).toBeTruthy();

    // The hold is real: a second request for the same seat/date must fail.
    const again = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-01-15",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    expect(again.status).toBe(409);
  }, 60_000);

  test("two concurrent requests for one seat: exactly one 201", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const body = {
      trainId: train.id,
      travelDate: "2027-01-16",
      passengers: [passengerFor(seats[0]!.id)],
    };

    const [a, b] = await Promise.all([
      call("/api/bookings", { token, body }),
      call("/api/bookings", { token, body }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    expect(await prisma.booking.count({ where: { trainId: train.id } })).toBe(1);
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(1);
  }, 60_000);

  test("rejects a payload with two passengers on the same seat", async () => {
    const { train, seats } = await makeTrain({ seats: 2 });
    const { token } = await makeUser();

    const res = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-01-17",
        passengers: [passengerFor(seats[0]!.id), passengerFor(seats[0]!.id)],
      },
    });

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.issues.length).toBeGreaterThan(0);
  }, 60_000);

  test("rejects a travel date in the past", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const res = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2020-01-01",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });

    expect(res.status).toBe(400);
  }, 60_000);

  test("rejects an impossible calendar date", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const res = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-02-31",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });

    expect(res.status).toBe(400);
  }, 60_000);

  test("unauthenticated requests get 401", async () => {
    const res = await call("/api/bookings", { body: {} });
    expect(res.status).toBe(401);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Reads and ownership
// ────────────────────────────────────────────────────────────────────

describe("booking reads", () => {
  test("the owner can read a booking; a stranger gets 404", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token: owner } = await makeUser();
    const { token: stranger } = await makeUser();

    const created = await call("/api/bookings", {
      token: owner,
      body: {
        trainId: train.id,
        travelDate: "2027-02-01",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    const asOwner = await call(`/api/bookings/${booking.id}`, { token: owner });
    expect(asOwner.status).toBe(200);

    const asStranger = await call(`/api/bookings/${booking.id}`, { token: stranger });
    // 404, not 403: the endpoint must not confirm that the id exists.
    expect(asStranger.status).toBe(404);
  }, 60_000);

  test("GET /api/bookings lists only the caller's bookings", async () => {
    const { train, seats } = await makeTrain({ seats: 2 });
    const { token: mine } = await makeUser();
    const { token: theirs } = await makeUser();

    await call("/api/bookings", {
      token: mine,
      body: {
        trainId: train.id,
        travelDate: "2027-02-02",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    await call("/api/bookings", {
      token: theirs,
      body: {
        trainId: train.id,
        travelDate: "2027-02-02",
        passengers: [passengerFor(seats[1]!.id)],
      },
    });

    const res = await call("/api/bookings", { token: mine });
    expect(res.status).toBe(200);

    const { bookings } = await json(res);
    expect(bookings).toHaveLength(1);
    expect(bookings[0].trainId).toBe(train.id);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Cancellation
// ────────────────────────────────────────────────────────────────────

describe("POST /api/bookings/:id/cancel", () => {
  test("releases the seats, and cancelling twice is a no-op", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const created = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-03-01",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    const first = await call(`/api/bookings/${booking.id}/cancel`, {
      token,
      method: "POST",
    });
    expect(first.status).toBe(200);

    const firstBody = await json(first);
    expect(firstBody.cancelled).toBe(true);
    expect(firstBody.releasedSeats).toBe(1);
    expect(firstBody.booking.status).toBe("CANCELLED");

    const second = await call(`/api/bookings/${booking.id}/cancel`, {
      token,
      method: "POST",
    });
    expect(second.status).toBe(200);
    expect((await json(second)).cancelled).toBe(false);

    // The seat is free again for the same date.
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(0);

    const rebook = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-03-01",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    expect(rebook.status).toBe(201);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Payments
// ────────────────────────────────────────────────────────────────────

describe("POST /api/bookings/:id/payment", () => {
  test("opens a payment once and returns the same row on retry", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const created = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-04-01",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    const first = await call(`/api/bookings/${booking.id}/payment`, {
      token,
      method: "POST",
    });
    expect(first.status).toBe(201);

    const firstBody = await json(first);
    expect(firstBody.payment.status).toBe("INITIATED");
    expect(firstBody.payment.amount).toBe(booking.totalAmount);
    expect(firstBody.checkout.orderId).toBe(firstBody.payment.providerOrderId);

    const second = await call(`/api/bookings/${booking.id}/payment`, {
      token,
      method: "POST",
    });
    expect(second.status).toBe(200);

    const secondBody = await json(second);
    expect(secondBody.payment.id).toBe(firstBody.payment.id);
    expect(secondBody.payment.providerOrderId).toBe(firstBody.payment.providerOrderId);

    // One payment row, whatever the client does.
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
  }, 60_000);

  test("honours an Idempotency-Key header across retries", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const created = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-04-02",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    const key = `key-${randomUUID()}`;

    const a = await call(`/api/bookings/${booking.id}/payment`, {
      token,
      method: "POST",
      headers: { "idempotency-key": key },
    });
    const b = await call(`/api/bookings/${booking.id}/payment`, {
      token,
      method: "POST",
      headers: { "idempotency-key": key },
    });

    const aBody = await json(a);
    const bBody = await json(b);
    expect(bBody.payment.id).toBe(aBody.payment.id);
    expect(bBody.payment.providerOrderId).toBe(aBody.payment.providerOrderId);
  }, 60_000);

  test("refuses to open a payment after the hold lapsed", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const created = await call("/api/bookings", {
      token,
      body: {
        trainId: train.id,
        travelDate: "2027-04-03",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    await prisma.booking.update({
      where: { id: booking.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await call(`/api/bookings/${booking.id}/payment`, {
      token,
      method: "POST",
    });
    expect(res.status).toBe(409);
  }, 60_000);

  test("a stranger cannot open a payment on someone else's booking", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token: owner } = await makeUser();
    const { token: stranger } = await makeUser();

    const created = await call("/api/bookings", {
      token: owner,
      body: {
        trainId: train.id,
        travelDate: "2027-04-04",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    const res = await call(`/api/bookings/${booking.id}/payment`, {
      token: stranger,
      method: "POST",
    });
    expect(res.status).toBe(404);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Webhooks
// ────────────────────────────────────────────────────────────────────

function signedWebhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  return {
    raw,
    headers: { "x-webhook-signature": signWebhook(raw, env.PAYMENT_WEBHOOK_SECRET) },
  };
}

describe("POST /api/webhooks/payment", () => {
  async function bookingAwaitingPayment(travelDate: string) {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token } = await makeUser();

    const created = await call("/api/bookings", {
      token,
      body: { trainId: train.id, travelDate, passengers: [passengerFor(seats[0]!.id)] },
    });
    const { booking } = await json(created);

    const opened = await call(`/api/bookings/${booking.id}/payment`, {
      token,
      method: "POST",
    });
    const { payment } = await json(opened);

    return { booking, payment };
  }

  test("a signed success webhook confirms the booking", async () => {
    const { booking, payment } = await bookingAwaitingPayment("2027-05-01");

    const { raw, headers } = signedWebhook({
      providerEventId: `evt_${randomUUID()}`,
      event: "payment.success",
      // Correlated by the gateway's order id, not our internal one.
      orderId: payment.providerOrderId,
      data: { amount: payment.amount },
    });

    const res = await call("/api/webhooks/payment", { rawBody: raw, headers });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.received).toBe(true);
    expect(body.recorded).toBe(true);
    expect(body.applied).toBe(true);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("CONFIRMED");
    expect(after?.holdExpiresAt).toBeNull();

    const freshPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(freshPayment?.status).toBe("SUCCESS");
    expect(freshPayment?.paidAt).toBeTruthy();
  }, 60_000);

  test("a replayed webhook is a 200 no-op", async () => {
    const { booking, payment } = await bookingAwaitingPayment("2027-05-02");

    const { raw, headers } = signedWebhook({
      providerEventId: `evt_${randomUUID()}`,
      event: "payment.success",
      orderId: payment.providerOrderId,
    });

    const first = await call("/api/webhooks/payment", { rawBody: raw, headers });
    expect(first.status).toBe(200);
    expect((await json(first)).recorded).toBe(true);

    const replay = await call("/api/webhooks/payment", { rawBody: raw, headers });
    expect(replay.status).toBe(200);
    expect((await json(replay)).recorded).toBe(false);

    expect(await prisma.paymentEvent.count({ where: { paymentId: payment.id } })).toBe(1);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("CONFIRMED");
  }, 60_000);

  test("a bad signature is rejected and changes nothing", async () => {
    const { booking, payment } = await bookingAwaitingPayment("2027-05-03");

    const raw = JSON.stringify({
      providerEventId: `evt_${randomUUID()}`,
      event: "payment.success",
      orderId: payment.providerOrderId,
    });

    const res = await call("/api/webhooks/payment", {
      rawBody: raw,
      headers: { "x-webhook-signature": "deadbeef" },
    });

    expect(res.status).toBe(401);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("PENDING");

    const freshPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(freshPayment?.status).toBe("INITIATED");
  }, 60_000);

  test("a missing signature is rejected", async () => {
    const { payment } = await bookingAwaitingPayment("2027-05-04");

    const raw = JSON.stringify({
      providerEventId: `evt_${randomUUID()}`,
      event: "payment.success",
      orderId: payment.providerOrderId,
    });

    const res = await call("/api/webhooks/payment", { rawBody: raw });
    expect(res.status).toBe(401);
  }, 60_000);

  test("an unknown order id gets 404", async () => {
    const { raw, headers } = signedWebhook({
      providerEventId: `evt_${randomUUID()}`,
      event: "payment.success",
      orderId: `ORD_does_not_exist_${randomUUID()}`,
    });

    const res = await call("/api/webhooks/payment", { rawBody: raw, headers });
    expect(res.status).toBe(404);
  }, 60_000);

  test("a late payment releases the money: booking stays cancelled", async () => {
    const { booking, payment } = await bookingAwaitingPayment("2027-05-05");

    await prisma.booking.update({
      where: { id: booking.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const { raw, headers } = signedWebhook({
      providerEventId: `evt_${randomUUID()}`,
      event: "payment.success",
      orderId: payment.providerOrderId,
    });

    const res = await call("/api/webhooks/payment", { rawBody: raw, headers });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.compensated).toBe(true);
    expect(body.reason).toBe("hold_expired");

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("CANCELLED");

    const freshPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(freshPayment?.status).toBe("REFUNDED");
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// Admin sweeper
// ────────────────────────────────────────────────────────────────────

describe("POST /api/admin/sweep-holds", () => {
  test("a customer is refused, an admin sweeps lapsed holds", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const { token: customer } = await makeUser("CUSTOMER");
    const { token: admin } = await makeUser("ADMIN");

    const created = await call("/api/bookings", {
      token: customer,
      body: {
        trainId: train.id,
        travelDate: "2027-06-01",
        passengers: [passengerFor(seats[0]!.id)],
      },
    });
    const { booking } = await json(created);

    const denied = await call("/api/admin/sweep-holds", {
      token: customer,
      method: "POST",
    });
    expect(denied.status).toBe(403);

    await prisma.booking.update({
      where: { id: booking.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const swept = await call("/api/admin/sweep-holds", { token: admin, method: "POST" });
    expect(swept.status).toBe(200);

    const body = await json(swept);
    expect(body.bookingIds).toContain(booking.id);
    expect(body.releasedSeats).toBeGreaterThanOrEqual(1);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("CANCELLED");
    expect(await prisma.bookingSeat.count({ where: { bookingId: booking.id } })).toBe(0);
  }, 60_000);

  test("unauthenticated sweep is refused", async () => {
    const res = await call("/api/admin/sweep-holds", { method: "POST" });
    expect(res.status).toBe(401);
  }, 60_000);
});
