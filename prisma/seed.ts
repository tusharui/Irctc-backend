import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

// Use the DIRECT url for seeding so it runs outside the pooler.
const adapter = new PrismaNeon({ connectionString: process.env.DIRECT_DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const STATIONS = [
  { code: "NDLS", name: "New Delhi", city: "Delhi", state: "Delhi", zone: "Northern" },
  { code: "BCT", name: "Mumbai CSMT", city: "Mumbai", state: "Maharashtra", zone: "Western" },
  { code: "SBC", name: "Bengaluru City", city: "Bengaluru", state: "Karnataka", zone: "Southern" },
  { code: "MAS", name: "Chennai Central", city: "Chennai", state: "Tamil Nadu", zone: "Southern" },
  { code: "KGP", name: "Kharagpur", city: "Kharagpur", state: "West Bengal", zone: "Eastern" },
  { code: "HYB", name: "Hyderabad", city: "Hyderabad", state: "Telangana", zone: "Central" },
];

const TRAINS = [
  { number: "12001", name: "Shatabdi Express", from: "NDLS", to: "BCT", dist: 1388, start: "06:00", end: "23:00" },
  { number: "12621", name: "Tamil Nadu Express", from: "NDLS", to: "MAS", dist: 2080, start: "21:10", end: "09:40" },
  { number: "12723", name: "Telangana Express", from: "HYB", to: "NDLS", dist: 1660, start: "19:15", end: "19:30" },
  { number: "12841", name: "Coromandel Express", from: "KGP", to: "SBC", dist: 1800, start: "11:55", end: "08:30" },
  { number: "12951", name: "Mumbai Rajdhani", from: "BCT", to: "NDLS", dist: 1388, start: "16:55", end: "08:20" },
];

const CLASSES = [
  { classType: "SLEEPER" as const, coaches: 10, seats: 80, farePerKm: 25, base: 5000 },
  { classType: "AC_3_TIER" as const, coaches: 8, seats: 80, farePerKm: 60, base: 15000 },
  { classType: "AC_2_TIER" as const, coaches: 6, seats: 80, farePerKm: 100, base: 25000 },
  { classType: "AC_1_TIER" as const, coaches: 2, seats: 40, farePerKm: 200, base: 50000 },
  { classType: "CHAIR_CAR" as const, coaches: 4, seats: 100, farePerKm: 40, base: 8000 },
];

async function main() {
  console.log("🌱 Seeding...");

  // ── Stations ───────────────────────────────────────────────
  const stationIds = new Map<string, string>();
  for (const s of STATIONS) {
    const row = await prisma.station.upsert({
      where: { code: s.code },
      update: {},
      create: s,
    });
    stationIds.set(s.code, row.id);
  }
  console.log(`  ✓ ${STATIONS.length} stations`);

  // ── Trains + classes + seats ───────────────────────────────
  for (const t of TRAINS) {
    const existing = await prisma.train.findUnique({ where: { number: t.number } });
    if (existing) {
      console.log(`  · ${t.number} already seeded, skipping`);
      continue;
    }

    const train = await prisma.train.create({
      data: {
        number: t.number,
        name: t.name,
        originStationId: stationIds.get(t.from)!,
        destStationId: stationIds.get(t.to)!,
        distanceKm: t.dist,
        startTime: t.start,
        endTime: t.end,
      },
    });

    for (const c of CLASSES) {
      const total = c.coaches * c.seats;
      const trainClass = await prisma.trainClass.create({
        data: {
          trainId: train.id,
          classType: c.classType,
          coachCount: c.coaches,
          seatsPerCoach: c.seats,
          totalSeats: total,
          farePerKm: c.farePerKm,
          baseFare: c.base,
        },
      });

      const seatRows: {
        trainClassId: string;
        coachNumber: number;
        seatNumber: number;
        isAvailable: boolean;
      }[] = [];
      for (let coach = 1; coach <= c.coaches; coach++) {
        for (let seat = 1; seat <= c.seats; seat++) {
          seatRows.push({
            trainClassId: trainClass.id,
            coachNumber: coach,
            seatNumber: seat,
            isAvailable: true,
          });
        }
      }
      await prisma.seat.createMany({ data: seatRows });
    }

    console.log(`  ✓ Train ${t.number} (${t.name})`);
  }

  const trainCount = await prisma.train.count();
  const seatCount = await prisma.seat.count();
  console.log(`✅ Seed complete — ${trainCount} trains, ${seatCount} seats`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
