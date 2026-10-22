
import { HTTPException } from "hono/http-exception";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/client";
import { isUniqueViolation } from "../../db/errors";
import { TRANSACTION_OPTIONS } from "../../db/transaction";

export type Gender = "MALE" | "FEMALE" | "OTHER";

export interface PassengerInput {
  name: string;
  age: number;
  gender: Gender;
  berthPreference?: string | null;
}

export interface ReserveInput {
  userId: string;
  trainId: string;
  /** Travel date. Normalised to UTC midnight before it reaches a DATE column. */
  travelDate: Date;
  seatIds: string[];
  passengers: PassengerInput[];
  /** How long the seats stay held while the customer pays. */
  holdMinutes?: number;
  /**
   * Boarding/alighting stops, as indices into the train's ordered route.
   * Omit both to sell the whole run. They travel together — one without the
   * other is a client bug, not a default.
   */
  fromStopIndex?: number;
  toStopIndex?: number;
}

export interface ReserveResult {
  bookingId: string;
  pnr: string;
  travelDate: Date;
  seatIds: string[];
  /** Fare total in paise, computed server-side. Never supplied by the client. */
  totalAmount: number;
  /** Segment actually sold. null when the whole run was booked. */
  fromStopIndex: number | null;
  toStopIndex: number | null;
  distanceKm: number;
  holdExpiresAt: Date;
}

export interface CancelResult {
  cancelled: boolean;
  releasedSeats: number;
  refunded: boolean;
}

const DEFAULT_HOLD_MINUTES = 10;
const MAX_HOLD_MINUTES = 60;

/** DATE columns have no timezone; pin the value to UTC midnight. */
export function toDateOnly(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
}

/**
 * A 10-character PNR. `randomUUID` is 122 bits of entropy, so ten hex
 * characters (40 bits) are plenty for a human-readable reference and avoid
 * the retry loop a naive counter would need.
 */
export function generatePnr(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
}

/** Fare for one seat, in paise. */
export function seatFare(
  cls: { baseFare: number; farePerKm: number },
  distanceKm: number
): number {
  return cls.baseFare + cls.farePerKm * distanceKm;
}

interface ResolvedBookingSegment {
  distanceKm: number;
  fromStopIndex: number | null;
  toStopIndex: number | null;
}

/**
 * Turn optional stop indices into a distance and a validated segment.
 *
 * Kept inside the transaction on purpose: the route can be edited while a
 * customer is checking out, and pricing against a stale route is how you end
 * up charging for a stop that no longer exists.
 */
async function resolveBookingSegment(
  tx: Prisma.TransactionClient,
  trainId: string,
  wholeRouteDistanceKm: number,
  fromStopIndex?: number,
  toStopIndex?: number
): Promise<ResolvedBookingSegment> {
  const hasFrom = fromStopIndex !== undefined;
  const hasTo = toStopIndex !== undefined;

  if (hasFrom !== hasTo) {
    throw new HTTPException(400, {
      message: "fromStopIndex and toStopIndex must be provided together",
    });
  }

  // Whole run. This is the behaviour every existing booking depended on.
  if (!hasFrom) {
    return {
      distanceKm: wholeRouteDistanceKm,
      fromStopIndex: null,
      toStopIndex: null,
    };
  }

  const stops = await tx.trainStop.findMany({
    where: { trainId, stopIndex: { in: [fromStopIndex!, toStopIndex!] } },
    select: { stopIndex: true, distanceKm: true },
  });

  const from = stops.find((stop) => stop.stopIndex === fromStopIndex);
  const to = stops.find((stop) => stop.stopIndex === toStopIndex);

  if (!from || !to) {
    throw new HTTPException(400, {
      message: "fromStopIndex and toStopIndex must both be stops on this train",
    });
  }
  if (from.stopIndex >= to.stopIndex) {
    throw new HTTPException(400, {
      message: "fromStopIndex must come before toStopIndex",
    });
  }

  const distanceKm = to.distanceKm - from.distanceKm;
  if (distanceKm <= 0) {
    throw new HTTPException(400, {
      message: "The selected stops have no distance between them",
    });
  }

  return {
    distanceKm,
    fromStopIndex: from.stopIndex,
    toStopIndex: to.stopIndex,
  };
}

interface LockedSeat {
  id: string;
  trainClassId: string;
  /** Operational availability — NOT occupancy. */
  isAvailable: boolean;
}

/**
 * Reserve every requested seat or none of them.
 *
 * Throws:
 *   400 — caller error (empty/duplicate/mismatched input, seat on another train)
 *   404 — a seat or train does not exist
 *   409 — a seat is blocked, or already taken for this date
 */
export async function reserveSeats(input: ReserveInput): Promise<ReserveResult> {
  const { seatIds, passengers } = input;

  if (seatIds.length === 0) {
    throw new HTTPException(400, { message: "At least one seat is required" });
  }
  if (seatIds.length !== passengers.length) {
    throw new HTTPException(400, {
      message: "Each passenger must be assigned exactly one seat",
    });
  }
  if (new Set(seatIds).size !== seatIds.length) {
    throw new HTTPException(400, { message: "Duplicate seat ids in request" });
  }

  const holdMinutes = Math.min(
    input.holdMinutes ?? DEFAULT_HOLD_MINUTES,
    MAX_HOLD_MINUTES
  );
  if (holdMinutes < 1) {
    throw new HTTPException(400, { message: "holdMinutes must be at least 1" });
  }

  const travelDate = toDateOnly(input.travelDate);
  const holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);

  try {
    return await prisma.$transaction(async (tx) => {
      // ── 1. Lock the rows, always in the same order ───────────────────
      // ORDER BY is not cosmetic: without it, two transactions locking
      // [A,B] and [B,A] deadlock under load.
      const locked = await tx.$queryRaw<LockedSeat[]>`
        SELECT "id", "trainClassId", "isAvailable"
        FROM "Seat"
        WHERE "id" IN (${Prisma.join(seatIds)})
        ORDER BY "id"
        FOR UPDATE
      `;

      if (locked.length !== seatIds.length) {
        throw new HTTPException(404, { message: "One or more seats do not exist" });
      }

      // ── 2. Operational availability (admin block) ────────────────────
      const blocked = locked.filter((seat) => !seat.isAvailable);
      if (blocked.length > 0) {
        throw new HTTPException(409, {
          message: "Seat is not available for booking",
        });
      }

      // ── 3. Occupancy for THIS date, under the lock ───────────────────
      const occupied = await tx.bookingSeat.findMany({
        where: { seatId: { in: seatIds }, travelDate },
        select: { seatId: true },
      });
      if (occupied.length > 0) {
        throw new HTTPException(409, {
          message: "Seat already booked for this travel date",
        });
      }

      // ── 4. Every seat must belong to the requested train ─────────────
      const classIds = [...new Set(locked.map((seat) => seat.trainClassId))];
      const classes = await tx.trainClass.findMany({
        where: { id: { in: classIds } },
        select: { id: true, trainId: true, baseFare: true, farePerKm: true },
      });

      if (classes.length !== classIds.length) {
        throw new HTTPException(404, { message: "Seat class not found" });
      }
      if (classes.some((cls) => cls.trainId !== input.trainId)) {
        throw new HTTPException(400, {
          message: "A seat does not belong to the requested train",
        });
      }

      const train = await tx.train.findUnique({
        where: { id: input.trainId },
        select: { distanceKm: true },
      });
      if (!train) {
        throw new HTTPException(404, { message: "Train not found" });
      }

      // ── 5. Which part of the run is this? ────────────────────────────
      // Fare is distance-based, so a Delhi → Bhopal passenger must not pay
      // the Delhi → Chennai fare. Whole-run bookings keep using
      // `Train.distanceKm`, which is what every existing row assumed.
      const segment = await resolveBookingSegment(
        tx,
        input.trainId,
        train.distanceKm,
        input.fromStopIndex,
        input.toStopIndex
      );

      // ── 6. Fare is computed here, never taken from the request ───────
      const classById = new Map(classes.map((cls) => [cls.id, cls]));
      const totalAmount = locked.reduce((sum, seat) => {
        const cls = classById.get(seat.trainClassId);
        return sum + (cls ? seatFare(cls, segment.distanceKm) : 0);
      }, 0);

      // ── 7. Write ─────────────────────────────────────────────────────
      const booking = await tx.booking.create({
        data: {
          pnr: generatePnr(),
          userId: input.userId,
          trainId: input.trainId,
          travelDate,
          status: "PENDING",
          totalAmount,
          fromStopIndex: segment.fromStopIndex,
          toStopIndex: segment.toStopIndex,
          holdExpiresAt,
        },
        select: { id: true, pnr: true },
      });

      await tx.bookingPassenger.createMany({
        data: passengers.map((p) => ({
          bookingId: booking.id,
          name: p.name,
          age: p.age,
          gender: p.gender,
          berthPref: p.berthPreference ?? null,
        })),
      });

      await tx.bookingSeat.createMany({
        data: locked.map((seat) => ({
          bookingId: booking.id,
          seatId: seat.id,
          trainClassId: seat.trainClassId,
          travelDate,
        })),
      });

      return {
        bookingId: booking.id,
        pnr: booking.pnr,
        travelDate,
        seatIds: locked.map((seat) => seat.id),
        totalAmount,
        fromStopIndex: segment.fromStopIndex,
        toStopIndex: segment.toStopIndex,
        distanceKm: segment.distanceKm,
        holdExpiresAt,
      };
    }, TRANSACTION_OPTIONS);
  } catch (err) {
    // The unique index on (seatId, travelDate) is the last line of defence.
    // If it fires, another transaction won the race between our lock
    // acquisition and our insert.
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, {
        message: "Seat already booked for this travel date",
      });
    }
    throw err;
  }
}

/**
 * Release a booking's seats. Idempotent: calling it twice releases nothing
 * the second time. The booking row is left untouched — cancelling is a
 * separate decision (see `cancelBooking`).
 */
export async function releaseBookingSeats(bookingId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const held = await tx.bookingSeat.findMany({
      where: { bookingId },
      select: { seatId: true },
    });

    if (held.length === 0) return 0;

    await tx.bookingSeat.deleteMany({ where: { bookingId } });

    return held.length;
  }, TRANSACTION_OPTIONS);
}

/**
 * Cancel a booking: release its seats, mark it CANCELLED, and refund a paid
 * payment. All in one transaction, after locking the booking row, so a
 * concurrent payment webhook cannot confirm the booking underneath us.
 *
 * Idempotent: cancelling an already-cancelled booking is a no-op.
 */
export async function cancelBooking(bookingId: string): Promise<CancelResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT "id", "status"::text AS "status"
      FROM "Booking"
      WHERE "id" = ${bookingId}
      FOR UPDATE
    `;

    const current = rows[0];
    if (!current) {
      throw new HTTPException(404, { message: "Booking not found" });
    }
    if (current.status === "CANCELLED") {
      return { cancelled: false, releasedSeats: 0, refunded: false };
    }

    const held = await tx.bookingSeat.findMany({
      where: { bookingId },
      select: { seatId: true },
    });
    await tx.bookingSeat.deleteMany({ where: { bookingId } });

    await tx.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", holdExpiresAt: null },
    });

    // A paid booking gets refunded. The mock provider settles instantly; a
    // real gateway would instead create a Refund row and call out to it.
    const payment = await tx.payment.findUnique({
      where: { bookingId },
      select: { id: true, status: true },
    });

    let refunded = false;
    if (payment && payment.status === "SUCCESS") {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "REFUNDED", version: { increment: 1 } },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          event: "payment.refunded",
          payload: { bookingId, reason: "booking_cancelled" },
          signatureValid: true,
          processedAt: new Date(),
        },
      });
      refunded = true;
    }

    return { cancelled: true, releasedSeats: held.length, refunded };
  }, TRANSACTION_OPTIONS);
}
