
import { HTTPException } from "hono/http-exception";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/client";
import { isUniqueViolation } from "../../db/errors";

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
  /** Fare total in paise. */
  totalAmount: number;
}

export interface ReserveResult {
  bookingId: string;
  pnr: string;
  travelDate: Date;
  seatIds: string[];
  holdExpiresAt: Date;
}

const DEFAULT_HOLD_MINUTES = 10;

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

interface LockedSeat {
  id: string;
  isAvailable: boolean;
  trainClassId: string;
}

/**
 * Reserve every requested seat or none of them.
 *
 * Throws:
 *   400 — caller error (empty/duplicate/mismatched input, seat on another train)
 *   404 — a seat id does not exist
 *   409 — a seat was taken by a concurrent request
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
  if (input.totalAmount < 0) {
    throw new HTTPException(400, { message: "totalAmount cannot be negative" });
  }

  const travelDate = toDateOnly(input.travelDate);
  const holdMinutes = input.holdMinutes ?? DEFAULT_HOLD_MINUTES;
  const holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);

  try {
    return await prisma.$transaction(async (tx) => {
      // ── 1. Lock the rows, always in the same order ───────────────────
      // ORDER BY is not cosmetic: without it, two transactions locking
      // [A,B] and [B,A] deadlock under load.
      const locked = await tx.$queryRaw<LockedSeat[]>`
        SELECT "id", "isAvailable", "trainClassId"
        FROM "Seat"
        WHERE "id" IN (${Prisma.join(seatIds)})
        ORDER BY "id"
        FOR UPDATE
      `;

      if (locked.length !== seatIds.length) {
        throw new HTTPException(404, { message: "One or more seats do not exist" });
      }

      // ── 2. Re-check under the lock ───────────────────────────────────
      // The read above is now protected; nobody can change these rows until
      // this transaction commits or rolls back.
      const taken = locked.filter((seat) => !seat.isAvailable);
      if (taken.length > 0) {
        throw new HTTPException(409, {
          message: "Seat no longer available",
        });
      }

      // ── 3. Every seat must belong to the requested train ─────────────
      const classIds = [...new Set(locked.map((seat) => seat.trainClassId))];
      const classes = await tx.trainClass.findMany({
        where: { id: { in: classIds } },
        select: { id: true, trainId: true },
      });

      if (classes.length !== classIds.length) {
        throw new HTTPException(404, { message: "Seat class not found" });
      }
      if (classes.some((cls) => cls.trainId !== input.trainId)) {
        throw new HTTPException(400, {
          message: "A seat does not belong to the requested train",
        });
      }

      // ── 4. Write ─────────────────────────────────────────────────────
      await tx.seat.updateMany({
        where: { id: { in: seatIds } },
        data: { isAvailable: false },
      });

      const booking = await tx.booking.create({
        data: {
          pnr: generatePnr(),
          userId: input.userId,
          trainId: input.trainId,
          travelDate,
          status: "PENDING",
          totalAmount: input.totalAmount,
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
        holdExpiresAt,
      };
    });
  } catch (err) {
    // The unique index on (seatId, travelDate) is the last line of defence.
    // If it fires, another transaction won the race between our lock
    // acquisition and our insert.
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, { message: "Seat no longer available" });
    }
    throw err;
  }
}

/**
 * Release a booking's seats and cancel it. Idempotent: calling it twice
 * releases nothing the second time.
 */
export async function releaseBookingSeats(bookingId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const held = await tx.bookingSeat.findMany({
      where: { bookingId },
      select: { seatId: true },
    });

    if (held.length === 0) return 0;

    await tx.seat.updateMany({
      where: { id: { in: held.map((h) => h.seatId) } },
      data: { isAvailable: true },
    });
    await tx.bookingSeat.deleteMany({ where: { bookingId } });

    return held.length;
  });
}
