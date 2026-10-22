import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";
import { env } from "../../env";
import { errorBody, zValidator } from "../../lib/validation";
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "../../lib/webhook-signature";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import { bookingIdParamSchema } from "../booking/booking.schemas";
import { openPayment } from "./payment.service";
import { webhookSchema } from "./payment.schemas";
import { handlePaymentWebhook } from "./webhook.service";

export const paymentRoutes = new Hono<{ Variables: AuthVariables }>();

// ────────────────────────────────────────────────────────────────────
// POST /api/bookings/:id/payment — open (or re-open) the gateway order
//
// Idempotent by design:
//   * the same booking returns the same payment row
//   * an `Idempotency-Key` header pins the result across retries
// ────────────────────────────────────────────────────────────────────

paymentRoutes.post(
  "/api/bookings/:id/payment",
  requireAuth,
  zValidator("param", bookingIdParamSchema),
  async (c) => {
    const { sub } = c.get("user");
    const { id } = c.req.valid("param");

    const booking = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    // 404 for someone else's booking: do not leak existence.
    if (!booking || booking.userId !== sub) {
      throw new HTTPException(404, { message: "Booking not found" });
    }

    const idempotencyKey =
      c.req.header("idempotency-key")?.trim() || undefined;

    const { payment, created } = await openPayment({
      bookingId: id,
      idempotencyKey,
    });

    return c.json(
      {
        payment,
        // Everything a client needs to hand off to the gateway.
        checkout: {
          provider: payment.provider,
          orderId: payment.providerOrderId,
          amount: payment.amount,
          currency: "INR",
        },
      },
      created ? 201 : 200
    );
  }
);

// ────────────────────────────────────────────────────────────────────
// POST /api/webhooks/payment — unauthenticated, signature-verified
//
// Always answers 2xx once the event is durably recorded, including on
// replay. A 5xx tells the gateway "retry", which is only correct when we
// genuinely failed to persist the event.
// ────────────────────────────────────────────────────────────────────

paymentRoutes.post("/api/webhooks/payment", async (c) => {
  // Raw text, not `c.req.json()`: the signature is over the exact bytes.
  const raw = await c.req.text();
  const signature = c.req.header(SIGNATURE_HEADER);
  const signatureValid = verifyWebhookSignature(
    raw,
    signature,
    env.PAYMENT_WEBHOOK_SECRET
  );

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return c.json(errorBody("Webhook body is not valid JSON"), 400);
  }

  const parsed = webhookSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return c.json(
      errorBody(
        "Invalid webhook payload",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        }))
      ),
      400
    );
  }

  const body = parsed.data;

  // Correlate: our id if supplied, otherwise the gateway's order id.
  const payment = body.paymentId
    ? await prisma.payment.findUnique({
        where: { id: body.paymentId },
        select: { id: true },
      })
    : await prisma.payment.findFirst({
        where: { providerOrderId: body.orderId },
        select: { id: true },
      });

  if (!payment) {
    throw new HTTPException(404, { message: "Unknown payment" });
  }

  try {
    const outcome = await handlePaymentWebhook({
      providerEventId: body.providerEventId,
      paymentId: payment.id,
      event: body.event,
      payload: body.data ?? {},
      signature: signature ?? null,
      signatureValid,
    });

    return c.json({ received: true, ...outcome });
  } catch (err) {
    // A bad signature is an authentication failure, not a malformed request.
    if (!signatureValid) {
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }
    throw err;
  }
});
