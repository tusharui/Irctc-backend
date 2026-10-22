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

interface SeedStop {
  code: string;
  /** Cumulative distance from the train's origin. Must strictly increase. */
  distanceKm: number;
  arrival: string | null;
  departure: string | null;
}

interface SeedTrain {
  number: string;
  name: string;
  from: string;
  to: string;
  dist: number;
  start: string;
  end: string;
  stops: SeedStop[];
}


const TRAINS: SeedTrain[] = [
  {
    number: "12001",
    name: "Shatabdi Express",
    from: "NDLS",
    to: "BCT",
    dist: 1388,
    start: "06:00",
    end: "23:00",
    stops: [
      { code: "NDLS", distanceKm: 0, arrival: null, departure: "06:00" },
      { code: "KGP", distanceKm: 700, arrival: "13:30", departure: "13:40" },
      { code: "BCT", distanceKm: 1388, arrival: "23:00", departure: null },
    ],
  },
  {
    number: "12621",
    name: "Tamil Nadu Express",
    from: "NDLS",
    to: "MAS",
    dist: 2080,
    start: "21:10",
    end: "09:40",
    stops: [
      { code: "NDLS", distanceKm: 0, arrival: null, departure: "21:10" },
      { code: "KGP", distanceKm: 1300, arrival: "06:00", departure: "06:10" },
      { code: "MAS", distanceKm: 2080, arrival: "09:40", departure: null },
    ],
  },
  {
    number: "12723",
    name: "Telangana Express",
    from: "HYB",
    to: "NDLS",
    dist: 1660,
    start: "19:15",
    end: "19:30",
    stops: [
      { code: "HYB", distanceKm: 0, arrival: null, departure: "19:15" },
      { code: "KGP", distanceKm: 1200, arrival: "06:30", departure: "06:40" },
      { code: "NDLS", distanceKm: 1660, arrival: "19:30", departure: null },
    ],
  },
  {
    number: "12841",
    name: "Coromandel Express",
    from: "KGP",
    to: "SBC",
    dist: 1800,
    start: "11:55",
    end: "08:30",
    stops: [
      { code: "KGP", distanceKm: 0, arrival: null, departure: "11:55" },
      { code: "MAS", distanceKm: 1400, arrival: "19:30", departure: "19:40" },
      { code: "SBC", distanceKm: 1800, arrival: "08:30", departure: null },
    ],
  },
  {
    number: "12951",
    name: "Mumbai Rajdhani",
    from: "BCT",
    to: "NDLS",
    dist: 1388,
    start: "16:55",
    end: "08:20",
    stops: [
      { code: "BCT", distanceKm: 0, arrival: null, departure: "16:55" },
      { code: "KGP", distanceKm: 600, arrival: "03:00", departure: "03:10" },
      { code: "NDLS", distanceKm: 1388, arrival: "08:20", departure: null },
    ],
  },
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

  // ── Trains + stops + classes + seats ───────────────────────
  //
  // Everything is an upsert so this file is safe to re-run: the first run
  // creates, later runs repair. In particular it now adds stops to trains
  // that were seeded before routes existed.
  for (const t of TRAINS) {
    const train = await prisma.train.upsert({
      where: { number: t.number },
      update: {
        name: t.name,
        originStationId: stationIds.get(t.from)!,
        destStationId: stationIds.get(t.to)!,
        distanceKm: t.dist,
        startTime: t.start,
        endTime: t.end,
      },
      create: {
        number: t.number,
        name: t.name,
        originStationId: stationIds.get(t.from)!,
        destStationId: stationIds.get(t.to)!,
        distanceKm: t.dist,
        startTime: t.start,
        endTime: t.end,
      },
    });

    // ── Ordered route ────────────────────────────────────────
    for (const [index, stop] of t.stops.entries()) {
      const stationId = stationIds.get(stop.code);
      if (!stationId) throw new Error(`Unknown station ${stop.code} on ${t.number}`);

      await prisma.trainStop.upsert({
        where: { trainId_stopIndex: { trainId: train.id, stopIndex: index } },
        update: {
          stationId,
          distanceKm: stop.distanceKm,
          arrival: stop.arrival,
          departure: stop.departure,
        },
        create: {
          trainId: train.id,
          stationId,
          stopIndex: index,
          distanceKm: stop.distanceKm,
          arrival: stop.arrival,
          departure: stop.departure,
        },
      });
    }

    // ── Classes + physical seats ─────────────────────────────
    for (const c of CLASSES) {
      const total = c.coaches * c.seats;
      const trainClass = await prisma.trainClass.upsert({
        where: { trainId_classType: { trainId: train.id, classType: c.classType } },
        update: {
          coachCount: c.coaches,
          seatsPerCoach: c.seats,
          totalSeats: total,
          farePerKm: c.farePerKm,
          baseFare: c.base,
        },
        create: {
          trainId: train.id,
          classType: c.classType,
          coachCount: c.coaches,
          seatsPerCoach: c.seats,
          totalSeats: total,
          farePerKm: c.farePerKm,
          baseFare: c.base,
        },
      });

      // Seats are the expensive part (800+ rows per coach type), so only
      // materialise them when the class is empty.
      const existingSeats = await prisma.seat.count({
        where: { trainClassId: trainClass.id },
      });
      if (existingSeats > 0) continue;

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

    console.log(`  ✓ Train ${t.number} (${t.name}) — ${t.stops.length} stops`);
  }

  const trainCount = await prisma.train.count();
  const stopCount = await prisma.trainStop.count();
  const seatCount = await prisma.seat.count();
  console.log(
    `✅ Seed complete — ${trainCount} trains, ${stopCount} stops, ${seatCount} seats`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
