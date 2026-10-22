-- ─────────────────────────────────────────────────────────────────────
-- Booking integrity: the constraints Prisma cannot express.
--
-- This migration introduces the v2 reservation core so the correctness
-- guarantees are enforced by Postgres itself, not by application code:
--
--   TicketSeat   the single authoritative reservation row, segment-aware
--                (fromStopIndex, toStopIndex) with a GiST EXCLUDE
--                constraint preventing overlapping segments on a seat
--   JourneySeat  physical seat inventory (no reservation state)
--   PaymentEvent append-only webhook ledger, idempotent by event id
--
-- Numbering note: stop indexes are 0-based along the route. Segments are
-- HALF-OPEN [from, to) so alighting at stop 3 and boarding at stop 3 on
-- the same seat do not conflict.
-- ─────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── Physical seat inventory ──────────────────────────────────────────
-- Holds NO reservation state: occupancy is always derived from TicketSeat,
-- so the two can never disagree.
CREATE TABLE IF NOT EXISTS "JourneySeat" (
  "id"            TEXT        NOT NULL,
  "journeyId"     TEXT        NOT NULL,
  "coachNumber"   INTEGER     NOT NULL,
  "seatNumber"    INTEGER     NOT NULL,
  "isBlocked"     BOOLEAN     NOT NULL DEFAULT false,
  "blockedReason" TEXT,
  "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "JourneySeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JourneySeat_seat_positive" CHECK ("coachNumber" > 0 AND "seatNumber" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "JourneySeat_journey_coach_seat_key"
  ON "JourneySeat" ("journeyId", "coachNumber", "seatNumber");

CREATE INDEX IF NOT EXISTS "JourneySeat_journeyId_isBlocked_idx"
  ON "JourneySeat" ("journeyId", "isBlocked");

-- ── The authoritative reservation ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TicketSeat" (
  "id"            TEXT        NOT NULL,
  "ticketId"      TEXT        NOT NULL,
  "journeySeatId" TEXT        NOT NULL,
  "journeyId"     TEXT        NOT NULL,
  "fromStopIndex" INTEGER     NOT NULL,
  "toStopIndex"   INTEGER     NOT NULL,
  "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TicketSeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketSeat_journeySeatId_fkey"
    FOREIGN KEY ("journeySeatId") REFERENCES "JourneySeat"("id") ON DELETE RESTRICT,
  -- A segment must advance along the route.
  CONSTRAINT "TicketSeat_valid_range" CHECK ("fromStopIndex" >= 0 AND "toStopIndex" > "fromStopIndex")
);

-- One ticket occupies at most one seat.
CREATE UNIQUE INDEX IF NOT EXISTS "TicketSeat_ticketId_key"
  ON "TicketSeat" ("ticketId");

-- Plain duplicate guard (exact same segment twice).
CREATE UNIQUE INDEX IF NOT EXISTS "TicketSeat_seat_segment_key"
  ON "TicketSeat" ("journeySeatId", "fromStopIndex", "toStopIndex");

CREATE INDEX IF NOT EXISTS "TicketSeat_journeySeatId_idx"
  ON "TicketSeat" ("journeySeatId");

-- ★ The core guarantee: no two reservations may occupy overlapping
--   segments of the same physical seat. This is what makes segment
--   booking safe and is impossible to express in the Prisma schema.
ALTER TABLE "TicketSeat" DROP CONSTRAINT IF EXISTS "TicketSeat_no_segment_overlap";
ALTER TABLE "TicketSeat"
  ADD CONSTRAINT "TicketSeat_no_segment_overlap"
  EXCLUDE USING gist (
    "journeySeatId" WITH =,
    int4range("fromStopIndex", "toStopIndex", '[)') WITH &&
  );

-- ── Append-only payment webhook ledger ───────────────────────────────
CREATE TABLE IF NOT EXISTS "PaymentEvent" (
  "id"              TEXT        NOT NULL,
  "paymentId"       TEXT        NOT NULL,
  "providerEventId" TEXT,
  "event"           TEXT        NOT NULL,
  "payload"         JSONB       NOT NULL,
  "signature"       TEXT,
  "signatureValid"  BOOLEAN     NOT NULL DEFAULT false,
  "processedAt"     TIMESTAMPTZ(3),
  "error"           TEXT,
  "createdAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentEvent_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE
);

-- Idempotency key: a replayed webhook cannot create a second row.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_providerEventId_key"
  ON "PaymentEvent" ("providerEventId");

CREATE INDEX IF NOT EXISTS "PaymentEvent_paymentId_createdAt_idx"
  ON "PaymentEvent" ("paymentId", "createdAt");

-- ── Idempotency + optimistic locking on Payment ──────────────────────
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_idempotencyKey_key"
  ON "Payment" ("idempotencyKey");

-- ── Seat holds ───────────────────────────────────────────────────────
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "holdExpiresAt" TIMESTAMPTZ(3);

-- Partial index: the sweeper only ever looks at PENDING rows.
CREATE INDEX IF NOT EXISTS "Booking_pending_hold_idx"
  ON "Booking" ("holdExpiresAt")
  WHERE "status" = 'PENDING';
