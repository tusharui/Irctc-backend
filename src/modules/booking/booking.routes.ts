import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";
import { zValidator } from "../../lib/validation";
import { requireAdmin, requireAuth, type AuthVariables } from "../../middleware/auth";
import { perIpRateLimit } from "../../middleware/rate-limit";
import { sweepExpiredHolds } from "./hold-sweeper";
import {
  bookingIdParamSchema,
  createBookingSchema,
  parseTravelDate,
} from "./booking.schemas";
import {
  cancelBooking,
  reserveSeats,
  toDateOnly,
} from "./reservation.service";

export const bookingRoutes = new Hono<{ Variables: AuthVariables }>();

/**
 * Everything a client is allowed to see about a booking. `payment` exposes
 * the gateway's order id but not internal fields; passengers and seat
 * assignments are included because that is the point of fetching a booking.
 */
const bookingDetailSelect = {
  id: true,
  pnr: true,
  userId: true,
  trainId: true,
  travelDate: true,
  status: true,
  totalAmount: true,
  fromStopIndex: true,
  toStopIndex: true,
  isRefundable: true,
  holdExpiresAt: true,
  createdAt: true,
  updatedAt: true,
  passengers: {
    select: { id: true, name: true, age: true, gender: true, berthPref: true },
  },
  seats: {
    select: {
      id: true,
      seatId: true,
      trainClassId: true,
      travelDate: true,
      seat: { select: { coachNumber: true, seatNumber: true } },
    },
  },
  payment: {
    select: {
      id: true,
      amount: true,
      status: true,
      provider: true,
      providerOrderId: true,
      paidAt: true,
      version: true,
    },
  },
} as const;

function assertNotInThePast(travelDate: Date): void {
  const today = toDateOnly(new Date());
  if (travelDate.getTime() < today.getTime()) {
    throw new HTTPException(400, {
      message: "travelDate cannot be in the past",
    });
  }
}

/**
 * Load a booking the caller owns. Returns 404 (not 403) when it belongs to
 * someone else, so the endpoint cannot be used to enumerate booking ids.
 */
async function loadOwnedBooking(bookingId: string, userId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: bookingDetailSelect,
  });

  if (!booking || booking.userId !== userId) {
    throw new HTTPException(404, { message: "Booking not found" });
  }

  return booking;
}

// ────────────────────────────────────────────────────────────────────
// POST /api/bookings — hold seats for a travel date
// ────────────────────────────────────────────────────────────────────

bookingRoutes.post(
  "/api/bookings",
  requireAuth,
  perIpRateLimit,
  zValidator("json", createBookingSchema),
  async (c) => {
    const { sub } = c.get("user");
    const body = c.req.valid("json");

    const travelDate = parseTravelDate(body.travelDate);
    assertNotInThePast(travelDate);

    // The client sends seatIds attached to passengers; the service wants
    // parallel arrays. Order is preserved, so passenger i gets seatIds[i].
    const result = await reserveSeats({
      userId: sub,
      trainId: body.trainId,
      travelDate,
      seatIds: body.passengers.map((p) => p.seatId),
      passengers: body.passengers.map(({ seatId: _seatId, ...rest }) => rest),
      holdMinutes: body.holdMinutes,
      fromStopIndex: body.fromStopIndex,
      toStopIndex: body.toStopIndex,
    });

    const booking = await loadOwnedBooking(result.bookingId, sub);

    return c.json({ booking }, 201);
  }
);

// ────────────────────────────────────────────────────────────────────
// GET /api/bookings — the caller's bookings, newest first
// ────────────────────────────────────────────────────────────────────

bookingRoutes.get("/api/bookings", requireAuth, async (c) => {
  const { sub } = c.get("user");

  const bookings = await prisma.booking.findMany({
    where: { userId: sub },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: bookingDetailSelect,
  });

  return c.json({ bookings });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/bookings/:id
// ────────────────────────────────────────────────────────────────────

bookingRoutes.get(
  "/api/bookings/:id",
  requireAuth,
  zValidator("param", bookingIdParamSchema),
  async (c) => {
    const { sub } = c.get("user");
    const booking = await loadOwnedBooking(c.req.valid("param").id, sub);
    return c.json({ booking });
  }
);

// ────────────────────────────────────────────────────────────────────
// POST /api/bookings/:id/cancel
// ────────────────────────────────────────────────────────────────────

bookingRoutes.post(
  "/api/bookings/:id/cancel",
  requireAuth,
  zValidator("param", bookingIdParamSchema),
  async (c) => {
    const { sub } = c.get("user");
    const { id } = c.req.valid("param");

    // Ownership check first: `cancelBooking` is an internal service and does
    // not know about callers.
    await loadOwnedBooking(id, sub);

    const result = await cancelBooking(id);
    const booking = await loadOwnedBooking(id, sub);

    return c.json({ ...result, booking });
  }
);

// ────────────────────────────────────────────────────────────────────
// POST /api/admin/sweep-holds — release expired holds on demand
//
// The same job should run on a schedule (cron / platform scheduler). This
// endpoint exists so an operator can trigger it, and so the behaviour is
// testable end to end.
// ────────────────────────────────────────────────────────────────────

bookingRoutes.post(
  "/api/admin/sweep-holds",
  requireAdmin,
  async (c) => {
    const result = await sweepExpiredHolds();
    return c.json(result);
  }
);
