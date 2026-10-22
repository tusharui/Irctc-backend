
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";
import { isUniqueViolation } from "../../db/errors";

export const paymentSelect = {
  id: true,
  bookingId: true,
  amount: true,
  status: true,
  provider: true,
  providerOrderId: true,
  paidAt: true,
  version: true,
  createdAt: true,
} as const;

export type PaymentView = NonNullable<
  Awaited<ReturnType<typeof findPayment>>
>;

export interface OpenPaymentResult {
  payment: PaymentView;
  /** true only when this call created the row. */
  created: boolean;
}

function findPayment(bookingId: string) {
  return prisma.payment.findUnique({
    where: { bookingId },
    select: paymentSelect,
  });
}

function newOrderId(): string {
  return `ORD_${crypto.randomUUID()}`;
}

function newIdempotencyKey(): string {
  return `IDEM_${crypto.randomUUID()}`;
}

/**
 * Return the booking's payment, creating it if necessary.
 *
 * Throws:
 *   404 — booking does not exist
 *   409 — booking is not awaiting payment, or its hold has lapsed
 */
export async function openPayment(input: {
  bookingId: string;
  idempotencyKey?: string;
}): Promise<OpenPaymentResult> {
  const { bookingId, idempotencyKey } = input;

  // ── Caller-supplied idempotency key wins ─────────────────────────────
  if (idempotencyKey) {
    const byKey = await prisma.payment.findUnique({
      where: { idempotencyKey },
      select: paymentSelect,
    });

    if (byKey) {
      if (byKey.bookingId !== bookingId) {
        throw new HTTPException(409, {
          message: "Idempotency key was already used for another booking",
        });
      }
      return { payment: byKey, created: false };
    }
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      totalAmount: true,
      holdExpiresAt: true,
    },
  });

  if (!booking) {
    throw new HTTPException(404, { message: "Booking not found" });
  }
  if (booking.status !== "PENDING") {
    throw new HTTPException(409, {
      message: `Booking is not awaiting payment (status: ${booking.status})`,
    });
  }

  // A lapsed hold is still PENDING until the sweeper runs. Do not let the
  // customer pay for seats that are about to be released.
  if (booking.holdExpiresAt && booking.holdExpiresAt.getTime() <= Date.now()) {
    throw new HTTPException(409, {
      message: "Seat hold has expired; please start a new booking",
    });
  }

  const existing = await findPayment(bookingId);
  if (existing) {
    // Already paid, or already waiting for the gateway: hand back the same
    // row so a retry cannot create a second charge.
    if (existing.status === "SUCCESS" || existing.status === "INITIATED") {
      return { payment: existing, created: false };
    }

    // FAILED / REFUNDED: reset the row for another attempt. The provider
    // order id must change — reusing it would collide with the old attempt.
    const retried = await prisma.payment.update({
      where: { id: existing.id },
      data: {
        status: "INITIATED",
        providerOrderId: newOrderId(),
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
        transactionId: null,
        paidAt: null,
        version: { increment: 1 },
      },
      select: paymentSelect,
    });
    return { payment: retried, created: false };
  }

  try {
    const created = await prisma.payment.create({
      data: {
        bookingId,
        amount: booking.totalAmount,
        status: "INITIATED",
        provider: "mock",
        providerOrderId: newOrderId(),
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      },
      select: paymentSelect,
    });
    return { payment: created, created: true };
  } catch (err) {
    // Another request created the payment between our read and our write.
    if (isUniqueViolation(err)) {
      const winner = await findPayment(bookingId);
      if (winner) return { payment: winner, created: false };
    }
    throw err;
  }
}
