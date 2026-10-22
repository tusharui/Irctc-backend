-- Separate the physical train from a dated service.
--
-- Before this migration `Train` carried `startTime`/`endTime`/`runsDaily`. That
-- made a train and "the 06:00 departure on 2026-11-01" the same row, which
-- breaks the moment a timetable changes or a train runs twice a day.
--
-- Now:
--   Train          — number, name, endpoints, ordered route
--   TrainSchedule  — which weekdays it runs, at what time, and when that
--                    timetable is valid
--   Journey        — one train on one calendar date, with real instants
--   JourneyClass   — that journey's snapshot of class fares and inventory

-- CreateEnum
CREATE TYPE "JourneyStatus" AS ENUM ('SCHEDULED', 'STARTED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TrainSchedule" (
    "id" TEXT NOT NULL,
    "trainId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "runNumber" INTEGER NOT NULL DEFAULT 1,
    "departTime" TEXT NOT NULL,
    "arriveTime" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrainSchedule_trainId_dayOfWeek_runNumber_key" ON "TrainSchedule"("trainId", "dayOfWeek", "runNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TrainSchedule_id_trainId_key" ON "TrainSchedule"("id", "trainId");

-- CreateIndex
CREATE INDEX "TrainSchedule_dayOfWeek_idx" ON "TrainSchedule"("dayOfWeek");

-- Backfill: every existing train ran daily at its stored times. The route is
-- unchanged, so one schedule row per weekday reproduces today's behaviour
-- exactly. `gen_random_uuid()` is a one-off id source here — Prisma still
-- generates ids in the application.
INSERT INTO "TrainSchedule" ("id", "trainId", "dayOfWeek", "runNumber", "departTime", "arriveTime", "validFrom")
SELECT gen_random_uuid()::text, t."id", d.dow, 1, t."startTime", t."endTime", DATE '2026-01-01'
FROM "Train" t
CROSS JOIN (SELECT generate_series(0, 6) AS dow) d;

-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL,
    "trainId" TEXT NOT NULL,
    "trainScheduleId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL DEFAULT 1,
    "date" DATE NOT NULL,
    "status" "JourneyStatus" NOT NULL DEFAULT 'SCHEDULED',
    "departureAt" TIMESTAMPTZ(3) NOT NULL,
    "arrivalAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Journey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Journey_trainId_date_runNumber_key" ON "Journey"("trainId", "date", "runNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Journey_id_trainId_key" ON "Journey"("id", "trainId");

-- CreateIndex
CREATE INDEX "Journey_date_idx" ON "Journey"("date");

-- CreateIndex
CREATE INDEX "Journey_trainId_date_idx" ON "Journey"("trainId", "date");

-- CreateTable
CREATE TABLE "JourneyClass" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "trainClassId" TEXT NOT NULL,
    "classType" "ClassType" NOT NULL,
    "coachCount" INTEGER NOT NULL,
    "seatsPerCoach" INTEGER NOT NULL,
    "totalSeats" INTEGER NOT NULL,
    "baseFare" INTEGER NOT NULL,
    "farePerKm" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JourneyClass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JourneyClass_journeyId_trainClassId_key" ON "JourneyClass"("journeyId", "trainClassId");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyClass_id_journeyId_key" ON "JourneyClass"("id", "journeyId");

-- CreateIndex
CREATE INDEX "JourneyClass_journeyId_classType_idx" ON "JourneyClass"("journeyId", "classType");

-- AddForeignKey
ALTER TABLE "TrainSchedule" ADD CONSTRAINT "TrainSchedule_trainId_fkey" FOREIGN KEY ("trainId") REFERENCES "Train"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_trainId_fkey" FOREIGN KEY ("trainId") REFERENCES "Train"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_trainScheduleId_trainId_fkey" FOREIGN KEY ("trainScheduleId", "trainId") REFERENCES "TrainSchedule"("id", "trainId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyClass" ADD CONSTRAINT "JourneyClass_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyClass" ADD CONSTRAINT "JourneyClass_trainClassId_fkey" FOREIGN KEY ("trainClassId") REFERENCES "TrainClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Train_originStationId_idx" ON "Train"("originStationId");

-- CreateIndex
CREATE INDEX "Train_destStationId_idx" ON "Train"("destStationId");

-- DropColumn: the timetable now lives on TrainSchedule.
ALTER TABLE "Train" DROP COLUMN "runsDaily",
DROP COLUMN "startTime",
DROP COLUMN "endTime";
