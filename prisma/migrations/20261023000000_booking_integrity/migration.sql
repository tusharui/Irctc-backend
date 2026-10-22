-- Booking integrity fixes
-- 1) Enable GiST for exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2) Make booking seat reservations date-aware in intent
--    v1 currently has BookingSeat.seatId with a global unique constraint.
--    That is the root of "rebooking impossible" + cross-date bleed.
--    Add a travel date to the allocation if missing and enforce uniqueness per (seatId, travelDate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'BookingSeat') THEN
    -- Add travelDate if not present
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'BookingSeat' AND column_name = 'travelDate'
    ) THEN
      ALTER TABLE "BookingSeat" ADD COLUMN "travelDate" DATE;
      -- Backfill from Booking
      UPDATE "BookingSeat" bs
         SET "travelDate" = b."travelDate"
        FROM "Booking" b
       WHERE bs."bookingId" = b."id"
         AND bs."travelDate" IS NULL;
      ALTER TABLE "BookingSeat" ALTER COLUMN "travelDate" SET NOT NULL;
    END IF;

    -- Drop the global uniqueness on seatId if it exists
    IF EXISTS (
      SELECT 1 FROM pg_constraint 
      WHERE conrelid = '"BookingSeat"'::regclass AND contype = 'u' AND conname = 'BookingSeat_seatId_key'
    ) THEN
      ALTER TABLE "BookingSeat" DROP CONSTRAINT "BookingSeat_seatId_key";
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_index 
      WHERE indexrelid = '"BookingSeat_seatId_key"'::regclass
    ) THEN
      DROP INDEX IF EXISTS "BookingSeat_seatId_key";
    END IF;

    -- Enforce one seat per (seatId, travelDate)
    CREATE UNIQUE INDEX IF NOT EXISTS "BookingSeat_seatId_travelDate_key" ON "BookingSeat"("seatId", "travelDate");
  END IF;
END $$;

-- 3) Segment overlap prevention for TicketSeat
--    Use half-open ranges [fromStopIndex, toStopIndex) to avoid double-counting at boundaries
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TicketSeat') THEN
    -- Ensure range is valid
    ALTER TABLE "TicketSeat" DROP CONSTRAINT IF EXISTS "TicketSeat_valid_range";
    ALTER TABLE "TicketSeat" ADD CONSTRAINT "TicketSeat_valid_range" CHECK ("fromStopIndex" < "toStopIndex");

    -- Exclusion constraint: no overlapping segments on same seat
    ALTER TABLE "TicketSeat" DROP CONSTRAINT IF EXISTS "TicketSeat_no_segment_overlap";
    ALTER TABLE "TicketSeat"
      ADD CONSTRAINT "TicketSeat_no_segment_overlap"
      EXCLUDE USING gist ("journeySeatId" WITH =, int4range("fromStopIndex", "toStopIndex", '[)') WITH &&);
  END IF;
END $$;

-- 4) Money/age sanity checks
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Booking') THEN
    ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_totalAmount_nonneg";
    ALTER TABLE "Booking" ADD CONSTRAINT "Booking_totalAmount_nonneg" CHECK ("totalAmount" >= 0);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Payment') THEN
    ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_amount_nonneg";
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_nonneg" CHECK (amount >= 0);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'FareItem') THEN
    ALTER TABLE "FareItem" DROP CONSTRAINT IF EXISTS "FareItem_amount_reasonable";
    ALTER TABLE "FareItem" ADD CONSTRAINT "FareItem_amount_reasonable" CHECK (amount >= -10000000 AND amount <= 10000000);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'BookingPassenger') THEN
    ALTER TABLE "BookingPassenger" DROP CONSTRAINT IF EXISTS "BookingPassenger_age_nonneg";
    ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_age_nonneg" CHECK (age >= 0 AND age <= 130);
  END IF;
END $$;

-- 5) Payment idempotency + webhook idempotency
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Payment') THEN
    ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
    ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "version" INTEGER DEFAULT 0;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'PaymentEvent') THEN
    ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "providerEventId" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_providerEventId_key" ON "PaymentEvent"("providerEventId") WHERE "providerEventId" IS NOT NULL;
    ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "signatureValid" BOOLEAN DEFAULT FALSE;
    ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMPTZ(3);
  END IF;
END $$;

-- 6) Holds + sweeper index
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Booking') THEN
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "holdExpiresAt" TIMESTAMPTZ(3);
    CREATE INDEX IF NOT EXISTS "Booking_pending_hold_idx" ON "Booking"("holdExpiresAt") WHERE status = 'PENDING';
  END IF;
END $$;

-- 7) Refund.ticketId relation support
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Refund') THEN
    ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "ticketId" TEXT;
    -- Add FK if Ticket table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Ticket') THEN
      ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "Refund_ticketId_fkey";
      ALTER TABLE "Refund" ADD CONSTRAINT "Refund_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"(id) ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    CREATE INDEX IF NOT EXISTS "Refund_ticketId_idx" ON "Refund"("ticketId");
  END IF;
END $$;
