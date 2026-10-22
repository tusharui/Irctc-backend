-- DropForeignKey
ALTER TABLE "PaymentEvent" DROP CONSTRAINT "PaymentEvent_paymentId_fkey";

-- DropForeignKey
ALTER TABLE "TicketSeat" DROP CONSTRAINT "TicketSeat_journeySeatId_fkey";

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "version" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSeat" ADD CONSTRAINT "TicketSeat_journeySeatId_fkey" FOREIGN KEY ("journeySeatId") REFERENCES "JourneySeat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "JourneySeat_journey_coach_seat_key" RENAME TO "JourneySeat_journeyId_coachNumber_seatNumber_key";

-- RenameIndex
ALTER INDEX "TicketSeat_seat_segment_key" RENAME TO "TicketSeat_journeySeatId_fromStopIndex_toStopIndex_key";
