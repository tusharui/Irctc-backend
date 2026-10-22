-- Journeys are sold between two stops, not only end to end.
--
-- Before this, `reserveSeats` priced every booking as the full run of the
-- train (`Train.distanceKm`). Search results that quote a Delhi → Bhopal fare
-- would then disagree with what the booking endpoint actually charged.
--
-- NULL/NULL means "the whole run", so existing rows stay valid. The CHECK
-- mirrors the half-open stop range used by `TicketSeat`: a passenger
-- alighting at stop 3 and another boarding at stop 3 do not conflict.

ALTER TABLE "Booking" ADD COLUMN "fromStopIndex" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "toStopIndex" INTEGER;

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_segment_pair" CHECK (
  ("fromStopIndex" IS NULL AND "toStopIndex" IS NULL)
  OR (
    "fromStopIndex" IS NOT NULL
    AND "toStopIndex" IS NOT NULL
    AND "fromStopIndex" >= 0
    AND "toStopIndex" > "fromStopIndex"
  )
);
