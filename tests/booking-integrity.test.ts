
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { prisma } from "../src/db/client";
import {
  generatePnr,
  releaseBookingSeats,
  reserveSeats,
  toDateOnly,
} from "../src/modules/booking/reservation.service";
import { sweepExpiredHolds } from "../src/modules/booking/hold-sweeper";
import {
  handlePaymentWebhook,
  recordPaymentEvent,
} from "../src/modules/payment/webhook.service";

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

const RUN_ID = Math.random().toString(36).slice(2, 8);
let seq = 0;
const tracked = { stations: [] as string[], trains: [] as string[], users: [] as string[] };

function code(prefix: string): string {
  seq += 1;
  return `${prefix}${RUN_ID}${seq}`.toUpperCase().slice(0, 20);
}

async function makeTrain(opts: { seats?: number; classType?: any } = {}) {
  const s1 = await prisma.station.create({
    data: { code: code("F"), name: "From", city: "From City" },
  });
  const s2 = await prisma.station.create({
    data: { code: code("T"), name: "To", city: "To City" },
  });
  const train = await prisma.train.create({
    data: {
      number: code("N"),
      name: "Integrity Express",
      originStationId: s1.id,
      destStationId: s2.id,
    },
  });
  const seatCount = opts.seats ?? 1;
  const cls = await prisma.trainClass.create({
    data: {
      trainId: train.id,
      classType: opts.classType ?? "SLEEPER",
      coachCount: 1,
      seatsPerCoach: seatCount,
      totalSeats: seatCount,
      farePerKm: 10,
      baseFare: 100,
    },
  });
  const seats = [];
  for (let i = 1; i <= seatCount; i++) {
    seats.push(
      await prisma.seat.create({
        data: { trainClassId: cls.id, coachNumber: 1, seatNumber: i, isAvailable: true },
      })
    );
  }
  tracked.stations.push(s1.id, s2.id);
  tracked.trains.push(train.id);
  return { s1, s2, train, cls, seats };
}

async function makeUser() {
  const user = await prisma.user.create({
    data: {
      email: `integrity+${RUN_ID}+${randomUUID()}@example.test`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$placeholder",
      name: "Integrity Tester",
    },
  });
  tracked.users.push(user.id);
  return user;
}

const passenger = { name: "Test Passenger", age: 30, gender: "MALE" as const };

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
// 1. Concurrent seat requests
// ────────────────────────────────────────────────────────────────────

describe("concurrent seat requests", () => {
  test("exactly one of two simultaneous reservations wins", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    const attempt = () =>
      reserveSeats({
        userId: user.id,
        trainId: train.id,
        travelDate: new Date("2026-12-01"),
        seatIds: [seats[0]!.id],
        passengers: [passenger],
      }).then(
        () => "won" as const,
        () => "lost" as const
      );

    // Both fired in the same tick, against the same seat.
    const results = await Promise.all([attempt(), attempt()]);

    expect(results.filter((r) => r === "won").length).toBe(1);

    // The database agrees: exactly one allocation for this date.
    // Note that Seat.isAvailable is intentionally NOT touched: occupancy is
    // derived from BookingSeat, so the same physical seat remains sellable on
    // every other travel date.
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(1);
    const stillOnSale = await prisma.seat.findUnique({ where: { id: seats[0]!.id } });
    expect(stillOnSale?.isAvailable).toBe(true);

    // And exactly one booking exists — no half-written loser.
    expect(await prisma.booking.count({ where: { trainId: train.id } })).toBe(1);
  }, 60_000);

  test("a three-way race still produces exactly one booking", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    const attempt = () =>
      reserveSeats({
        userId: user.id,
        trainId: train.id,
        travelDate: new Date("2026-12-02"),
        seatIds: [seats[0]!.id],
        passengers: [passenger],
      }).then(
        () => "won" as const,
        () => "lost" as const
      );

    const results = await Promise.all([attempt(), attempt(), attempt()]);

    expect(results.filter((r) => r === "won").length).toBe(1);
    expect(await prisma.booking.count({ where: { trainId: train.id } })).toBe(1);
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(1);
  }, 60_000);

  test("all-or-nothing: a request for two seats where one is taken reserves neither", async () => {
    const { train, seats } = await makeTrain({ seats: 2 });
    const user = await makeUser();

    // Take seat 1 first.
    await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-03"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    // Now ask for both. The second is free, but the first is not: the whole
    // transaction must roll back rather than reserve a partial set.
    let failed = false;
    try {
      await reserveSeats({
        userId: user.id,
        trainId: train.id,
        travelDate: new Date("2026-12-03"),
        seatIds: [seats[0]!.id, seats[1]!.id],
        passengers: [passenger, passenger],
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);

    // Seat 2 must still be free - no partial reservation leaked.
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[1]!.id } })).toBe(0);
  }, 60_000);

  test("the same seat is bookable on a different travel date", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    // This is the regression guard for the original `@@unique([seatId])`:
    // a seat used to be bookable exactly once, forever.
    const first = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-04"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });
    expect(first.bookingId).toBeTruthy();

    // Free it again (as if cancelled), then book the same seat, same train,
    // different date.
    await releaseBookingSeats(first.bookingId);

    const second = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-05"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    expect(second.bookingId).not.toBe(first.bookingId);
    expect(second.travelDate.toISOString().slice(0, 10)).toBe("2026-12-05");
  }, 60_000);

  test("the same seat can be held on two different dates at once", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    // The seat is physically one seat, but it is a different seat on a
    // different day. Nothing about booking 2026-12-06 should affect
    // 2026-12-07. This is what the date-aware unique index buys us; the old
    // global `UNIQUE(seatId)` (and using Seat.isAvailable as occupancy)
    // made this impossible.
    const monday = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-06"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    const tuesday = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-07"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    expect(tuesday.bookingId).not.toBe(monday.bookingId);
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(2);

    // ...but a THIRD booking on the same date as an existing one is refused.
    let rejected = false;
    try {
      await reserveSeats({
        userId: user.id,
        trainId: train.id,
        travelDate: new Date("2026-12-06"),
        seatIds: [seats[0]!.id],
        passengers: [passenger],
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 60_000);

  test("travel dates are normalised: a timestamp becomes UTC midnight", async () => {
    const value = toDateOnly(new Date("2026-12-31T23:59:00+05:30"));
    expect(value.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  test("PNRs are 10 characters and unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const pnr = generatePnr();
      expect(pnr).toHaveLength(10);
      seen.add(pnr);
    }
    expect(seen.size).toBe(1000);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Overlapping journey segments
// ────────────────────────────────────────────────────────────────────

describe("overlapping journey segments", () => {
  async function seatForSegmentTest() {
    const { train } = await makeTrain({ seats: 1 });
    const journeySeat = await prisma.journeySeat.create({
      data: {
        journeyId: `journey-${randomUUID()}`,
        coachNumber: 1,
        seatNumber: 1,
      },
    });
    return { train, journeySeat };
  }

  function occupy(journeySeatId: string, from: number, to: number) {
    return prisma.$executeRaw`
      INSERT INTO "TicketSeat"
        ("id", "ticketId", "journeySeatId", "journeyId", "fromStopIndex", "toStopIndex")
      VALUES
        (${randomUUID()}, ${randomUUID()}, ${journeySeatId}, ${"j"}, ${from}, ${to})
    `;
  }

  test("the exclusion constraint exists in the database", async () => {
    // Guards against a future `prisma migrate dev` silently dropping a
    // constraint Prisma does not model.
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE conname = 'TicketSeat_no_segment_overlap'
    `;
    expect(Number(rows[0]!.n)).toBe(1);
  }, 30_000);

  test("an overlapping segment on the same seat is rejected", async () => {
    const { journeySeat } = await seatForSegmentTest();

    // Passenger A: stops 0 → 3
    await occupy(journeySeat.id, 0, 3);

    // Passenger B: stops 2 → 5 overlaps 2–3. Must fail.
    let rejected = false;
    try {
      await occupy(journeySeat.id, 2, 5);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // Cleanup the accepted row (no FK to Ticket in this partial migration).
    await prisma.$executeRaw`DELETE FROM "TicketSeat" WHERE "journeySeatId" = ${journeySeat.id}`;
  }, 60_000);

  test("touching segments are allowed: alight at 3, board at 3", async () => {
    const { journeySeat } = await seatForSegmentTest();

    await occupy(journeySeat.id, 0, 3);
    // [0,3) and [3,5) do not overlap — this is the whole point of
    // half-open ranges, and what makes segment booking work at all.
    await occupy(journeySeat.id, 3, 5);

    const count = await prisma.ticketSeat.count({
      where: { journeySeatId: journeySeat.id },
    });
    expect(count).toBe(2);

    await prisma.$executeRaw`DELETE FROM "TicketSeat" WHERE "journeySeatId" = ${journeySeat.id}`;
  }, 60_000);

  test("an identical segment is rejected by the plain unique index too", async () => {
    const { journeySeat } = await seatForSegmentTest();

    await occupy(journeySeat.id, 0, 3);

    let rejected = false;
    try {
      await occupy(journeySeat.id, 0, 3);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    await prisma.$executeRaw`DELETE FROM "TicketSeat" WHERE "journeySeatId" = ${journeySeat.id}`;
  }, 60_000);

  test("a non-overlapping segment elsewhere on the same seat is allowed", async () => {
    const { journeySeat } = await seatForSegmentTest();

    await occupy(journeySeat.id, 4, 8);
    await occupy(journeySeat.id, 0, 2);

    const count = await prisma.ticketSeat.count({
      where: { journeySeatId: journeySeat.id },
    });
    expect(count).toBe(2);

    await prisma.$executeRaw`DELETE FROM "TicketSeat" WHERE "journeySeatId" = ${journeySeat.id}`;
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// 3. Duplicate payment webhooks
// ────────────────────────────────────────────────────────────────────

describe("duplicate payment webhooks", () => {
  async function pendingBookingWithPayment(amount = 500) {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    const reservation = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-10"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    const payment = await prisma.payment.create({
      data: {
        bookingId: reservation.bookingId,
        amount,
        status: "INITIATED",
        provider: "mock",
        providerOrderId: `ORD_${randomUUID()}`,
        idempotencyKey: `IDEM_${randomUUID()}`,
      },
    });

    return { reservation, payment, train, seats, user };
  }

  const envelope = (paymentId: string, providerEventId: string) => ({
    providerEventId,
    paymentId,
    event: "payment.success",
    payload: { event: "payment.success", amount: 500 },
    signature: "test-signature",
    signatureValid: true,
  });

  test("a replayed webhook is absorbed, not re-applied", async () => {
    const { reservation, payment } = await pendingBookingWithPayment();
    const eventId = `EVT_${randomUUID()}`;

    const first = await handlePaymentWebhook(envelope(payment.id, eventId));
    const second = await handlePaymentWebhook(envelope(payment.id, eventId));
    const third = await handlePaymentWebhook(envelope(payment.id, eventId));

    expect(first.recorded).toBe(true);
    expect(first.applied).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.reason).toBe("duplicate_event");
    expect(third.recorded).toBe(false);

    // Exactly one ledger row, exactly one state transition.
    expect(
      await prisma.paymentEvent.count({ where: { paymentId: payment.id } })
    ).toBe(1);

    const booking = await prisma.booking.findUnique({ where: { id: reservation.bookingId } });
    expect(booking?.status).toBe("CONFIRMED");
  }, 60_000);

  test("concurrent duplicate deliveries: only one applies", async () => {
    const { payment } = await pendingBookingWithPayment();
    const eventId = `EVT_${randomUUID()}`;

    // Five simultaneous deliveries of the SAME event.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        handlePaymentWebhook(envelope(payment.id, eventId))
      )
    );

    expect(outcomes.filter((o) => o.recorded).length).toBe(1);
    expect(await prisma.paymentEvent.count({ where: { paymentId: payment.id } })).toBe(1);

    const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(fresh?.status).toBe("SUCCESS");
    expect(fresh?.version).toBe(1);
  }, 60_000);

  test("two different events on one payment are both recorded", async () => {
    const { payment } = await pendingBookingWithPayment();

    await recordPaymentEvent({
      providerEventId: `EVT_${randomUUID()}`,
      paymentId: payment.id,
      event: "payment.authorized",
      payload: {},
      signatureValid: true,
    });
    await recordPaymentEvent({
      providerEventId: `EVT_${randomUUID()}`,
      paymentId: payment.id,
      event: "payment.captured",
      payload: {},
      signatureValid: true,
    });

    expect(await prisma.paymentEvent.count({ where: { paymentId: payment.id } })).toBe(2);
  }, 60_000);

  test("an unsigned webhook is rejected and never applied", async () => {
    const { payment, reservation } = await pendingBookingWithPayment();

    let rejected = false;
    try {
      await handlePaymentWebhook({
        ...envelope(payment.id, `EVT_${randomUUID()}`),
        signatureValid: false,
      });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);

    const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(fresh?.status).toBe("INITIATED");

    const booking = await prisma.booking.findUnique({ where: { id: reservation.bookingId } });
    expect(booking?.status).toBe("PENDING");
  }, 60_000);

  test("a payment that arrives after the hold lapsed is compensated", async () => {
    const { reservation, payment, train } = await pendingBookingWithPayment();

    // Force the hold to expire, then run the sweeper for real.
    await prisma.booking.update({
      where: { id: reservation.bookingId },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
    const swept = await sweepExpiredHolds();
    expect(swept.bookingIds).toContain(reservation.bookingId);

    // The customer's payment lands late.
    const outcome = await handlePaymentWebhook(
      envelope(payment.id, `EVT_${randomUUID()}`)
    );

    expect(outcome.recorded).toBe(true);
    expect(outcome.compensated).toBe(true);
    expect(outcome.reason).toBe("hold_expired");

    // Money is not silently kept: the payment is marked refunded.
    const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(fresh?.status).toBe("REFUNDED");

    // And the booking stays cancelled — a late payment must not resurrect it.
    const booking = await prisma.booking.findUnique({ where: { id: reservation.bookingId } });
    expect(booking?.status).toBe("CANCELLED");

    void train;
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────
// 4. Expired holds
// ────────────────────────────────────────────────────────────────────

describe("expired holds", () => {
  async function holdThatLapsed(minutesAgo = 1) {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    const reservation = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-11"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    // Simulate time passing.
    await prisma.booking.update({
      where: { id: reservation.bookingId },
      data: { holdExpiresAt: new Date(Date.now() - minutesAgo * 60_000) },
    });

    return { reservation, seats, train, user };
  }

  test("a lapsed hold is expired and its seats return to inventory", async () => {
    const { reservation, seats } = await holdThatLapsed();

    const result = await sweepExpiredHolds();

    expect(result.bookingIds).toContain(reservation.bookingId);
    expect(result.releasedSeats).toBeGreaterThanOrEqual(1);

    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(0);

    const booking = await prisma.booking.findUnique({ where: { id: reservation.bookingId } });
    expect(booking?.status).toBe("CANCELLED");

    expect(
      await prisma.bookingSeat.count({ where: { bookingId: reservation.bookingId } })
    ).toBe(0);
  }, 60_000);

  test("a live hold is not swept", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    const reservation = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-12"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
      holdMinutes: 10,
    });

    const result = await sweepExpiredHolds();
    expect(result.bookingIds).not.toContain(reservation.bookingId);

    const booking = await prisma.booking.findUnique({ where: { id: reservation.bookingId } });
    expect(booking?.status).toBe("PENDING");

    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(1);
  }, 60_000);

  test("the sweeper is idempotent: a second pass is a no-op", async () => {
    const { reservation } = await holdThatLapsed();

    const first = await sweepExpiredHolds();
    const second = await sweepExpiredHolds();

    expect(first.bookingIds).toContain(reservation.bookingId);
    expect(second.bookingIds).not.toContain(reservation.bookingId);
    expect(second.releasedSeats).toBe(0);
  }, 60_000);

  test("seats released by the sweeper can immediately be rebooked", async () => {
    const { reservation, seats, train } = await holdThatLapsed();
    await sweepExpiredHolds();

    const user = await makeUser();
    const rebooked = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-11"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    expect(rebooked.bookingId).not.toBe(reservation.bookingId);
    expect(await prisma.bookingSeat.count({ where: { seatId: seats[0]!.id } })).toBe(1);
  }, 60_000);

  test("releaseBookingSeats is idempotent", async () => {
    const { train, seats } = await makeTrain({ seats: 1 });
    const user = await makeUser();

    const reservation = await reserveSeats({
      userId: user.id,
      trainId: train.id,
      travelDate: new Date("2026-12-13"),
      seatIds: [seats[0]!.id],
      passengers: [passenger],
    });

    expect(await releaseBookingSeats(reservation.bookingId)).toBe(1);
    expect(await releaseBookingSeats(reservation.bookingId)).toBe(0);
  }, 60_000);
});
