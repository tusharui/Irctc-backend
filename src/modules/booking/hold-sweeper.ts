
import { prisma } from "../../db/client";
import { TRANSACTION_OPTIONS } from "../../db/transaction";

export interface SweepResult {
  /** Number of bookings expired by this pass. */
  expiredBookings: number;
  /** Number of seats returned to inventory. */
  releasedSeats: number;
  bookingIds: string[];
}

export interface SweepOptions {
  /** Evaluate against this instant instead of now(). Tests inject a clock. */
  now?: Date;
  /** Stop after this many bookings per pass. */
  batchSize?: number;
}

export async function sweepExpiredHolds(
  options: SweepOptions = {}
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 200;

  return prisma.$transaction(async (tx) => {
    // Claim the lapsed holds. SKIP LOCKED means a second sweeper running at
    // the same time simply works on different rows instead of deadlocking.
    const lapsed = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "Booking"
      WHERE "status" = 'PENDING'
        AND "holdExpiresAt" IS NOT NULL
        AND "holdExpiresAt" < ${now}
      ORDER BY "holdExpiresAt"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    if (lapsed.length === 0) {
      return { expiredBookings: 0, releasedSeats: 0, bookingIds: [] };
    }

    const bookingIds = lapsed.map((row) => row.id);

    // Free the seats. Deleting the allocation IS the release: occupancy is
    // derived from BookingSeat, so there is no second flag to keep in sync.
    const held = await tx.bookingSeat.findMany({
      where: { bookingId: { in: bookingIds } },
      select: { seatId: true },
    });

    await tx.bookingSeat.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });

    await tx.booking.updateMany({
      where: { id: { in: bookingIds }, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    return {
      expiredBookings: lapsed.length,
      releasedSeats: held.length,
      bookingIds,
    };
  }, TRANSACTION_OPTIONS);
}
