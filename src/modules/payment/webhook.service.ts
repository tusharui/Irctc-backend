
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";

export interface WebhookEnvelope {
  /** The gateway's own event id. This is THE idempotency key. */
  providerEventId: string;
  paymentId: string;
  event: string;
  payload: unknown;
  signature?: string | null;
  signatureValid: boolean;
}

export interface WebhookOutcome {
  /** false when the event had already been recorded (a replay). */
  recorded: boolean;
  /** Whether this delivery changed application state. */
  applied: boolean;
  /** Set when the payment succeeded after the hold had lapsed. */
  compensated?: boolean;
  reason?: string;
}

/**
 * Record an event, exactly once.
 *
 * Returns true if this call inserted the row, false if the event id was
 * already present. Callers should do nothing on false — that is the retry
 * being absorbed.
 */
export async function recordPaymentEvent(
  envelope: WebhookEnvelope
): Promise<boolean> {
  const inserted = await prisma.$executeRaw`
    INSERT INTO "PaymentEvent"
      ("id", "paymentId", "providerEventId", "event", "payload", "signature", "signatureValid")
    VALUES
      (${crypto.randomUUID()}, ${envelope.paymentId}, ${envelope.providerEventId},
       ${envelope.event}, ${JSON.stringify(envelope.payload)}::jsonb,
       ${envelope.signature ?? null}, ${envelope.signatureValid})
    ON CONFLICT ("providerEventId") DO NOTHING
  `;

  return inserted === 1;
}

/**
 * Compare-and-set a payment's status. Returns false when another handler
 * already moved it, which means this delivery is stale and must not apply.
 */
async function transitionPayment(
  paymentId: string,
  from: readonly string[],
  to: string,
  extra: { transactionId?: string; paidAt?: Date; failureReason?: string | null } = {}
): Promise<boolean> {
  const current = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { version: true, status: true },
  });

  if (!current) {
    throw new HTTPException(404, { message: "Payment not found" });
  }
  if (!from.includes(current.status)) return false;

  const updated = await prisma.payment.updateMany({
    where: { id: paymentId, version: current.version },
    data: {
      status: to as never,
      version: { increment: 1 },
      ...(extra.transactionId !== undefined
        ? { transactionId: extra.transactionId }
        : {}),
      ...(extra.paidAt ? { paidAt: extra.paidAt } : {}),
      ...(extra.failureReason !== undefined
        ? { failureReason: extra.failureReason }
        : {}),
    },
  });

  // 0 rows means the version moved between our read and our write.
  return updated.count === 1;
}

/**
 * Handle one webhook delivery end to end.
 *
 * Safe to call concurrently and repeatedly with the same envelope.
 */
export async function handlePaymentWebhook(
  envelope: WebhookEnvelope
): Promise<WebhookOutcome> {
  // ── 1. Reject unverified senders before touching money ──────────────
  if (!envelope.signatureValid) {
    await recordPaymentEvent({ ...envelope, signatureValid: false }).catch(
      () => undefined
    );
    throw new HTTPException(400, { message: "Invalid webhook signature" });
  }

  // ── 2. Idempotency gate ─────────────────────────────────────────────
  const recorded = await recordPaymentEvent(envelope);
  if (!recorded) {
    return { recorded: false, applied: false, reason: "duplicate_event" };
  }

  // ── 3. Apply the transition ─────────────────────────────────────────
  if (envelope.event === "payment.failed") {
    await transitionPayment(envelope.paymentId, ["INITIATED"], "FAILED", {
      failureReason: "Gateway reported failure",
    });
    return { recorded: true, applied: true };
  }

  if (envelope.event !== "payment.success" && envelope.event !== "payment.captured") {
    // Unknown-but-verified events are recorded for audit, not applied.
    return { recorded: true, applied: false, reason: "unhandled_event" };
  }

  const payment = await prisma.payment.findUnique({
    where: { id: envelope.paymentId },
    select: {
      id: true,
      bookingId: true,
      status: true,
      booking: { select: { id: true, status: true } },
    },
  });

  if (!payment) {
    throw new HTTPException(404, { message: "Payment not found" });
  }

  const moved = await transitionPayment(
    envelope.paymentId,
    ["INITIATED", "PROCESSING"],
    "SUCCESS",
    {
      transactionId: `TXN_${crypto.randomUUID()}`,
      paidAt: new Date(),
    }
  );

  if (!moved) {
    // Already SUCCESS, or moved by a competing delivery.
    return { recorded: true, applied: false, reason: "already_settled" };
  }

  // ── 4. Late payment: the hold already lapsed ────────────────────────
  if (payment.booking.status !== "PENDING") {
    await compensateLatePayment(payment.bookingId, envelope.paymentId);
    return {
      recorded: true,
      applied: true,
      compensated: true,
      reason: "hold_expired",
    };
  }

  // ── 5. Confirm the booking ──────────────────────────────────────────
  await prisma.booking.updateMany({
    where: { id: payment.bookingId, status: "PENDING" },
    data: { status: "CONFIRMED", holdExpiresAt: null },
  });

  return { recorded: true, applied: true };
}

/**
 * The customer paid, but the seats were already released. Refund in full and
 * leave a trail. This must never be silent.
 */
async function compensateLatePayment(
  bookingId: string,
  paymentId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: "REFUNDED" },
    });

    await tx.paymentEvent.create({
      data: {
        paymentId,
        event: "payment.refunded_hold_expired",
        payload: { bookingId, reason: "hold_expired" },
        signatureValid: true,
        processedAt: new Date(),
      },
    });
  });
}
