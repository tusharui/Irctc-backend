# IRCTC Backend

Bun + TypeScript + Hono + Prisma 7 + Neon (Postgres).

See **[SETUP.md](./SETUP.md)** for the full guide, commands, and API reference.

## Quick start

```bash
bun install
bun run db:generate
bun run db:migrate
bun run db:seed
bun run dev
```

Server runs on **http://localhost:4000** (`PORT` in `.env`).

```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/db-check
```

## API

| Method | Path | Auth | Does |
|---|---|---|---|
| `GET` | `/health` | — | Liveness check |
| `GET` | `/api/db-check` | — | Round-trips the database |
| `POST` | `/api/auth/register` | — | Create a user, returns `{ user, token }` (201) |
| `POST` | `/api/auth/login` | — | Exchange credentials for `{ user, token }` (200) |
| `GET` | `/api/auth/me` | Bearer | The current user, re-read from the database (200) |
| `GET` | `/api/v1/stations?search=Delhi` | — | Station typeahead by code, name or city (200) |
| `GET` | `/api/v1/trains/search` | — | Trains between two stations for a date (200) |
| `GET` | `/api/v1/journeys/:journeyId/availability` | — | Per-class seats left on one dated journey (200) |
| `POST` | `/api/bookings` | Bearer | Hold seats for a travel date, returns the booking (201) |
| `GET` | `/api/bookings` | Bearer | The caller's bookings, newest first (200) |
| `GET` | `/api/bookings/:id` | Bearer | One booking, owner only (200) |
| `POST` | `/api/bookings/:id/cancel` | Bearer | Release seats, cancel, refund if paid (200) |
| `POST` | `/api/bookings/:id/payment` | Bearer | Open the gateway order, idempotent (201 / 200) |
| `POST` | `/api/webhooks/payment` | HMAC | Payment gateway callback (200) |
| `POST` | `/api/admin/sweep-holds` | Admin | Release expired holds on demand (200) |

```bash
# Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You"}'

# Use the token
curl http://localhost:4000/api/auth/me -H "Authorization: Bearer <token>"

# Station typeahead
curl "http://localhost:4000/api/v1/stations?search=Delhi"

# Search: one result per train running that weekday, each with a journeyId
curl "http://localhost:4000/api/v1/trains/search?from=NDLS&to=JP&date=2026-11-01"

# Availability for that journey, whole run
curl "http://localhost:4000/api/v1/journeys/<journeyId>/availability"

# Availability for a segment of that journey
curl "http://localhost:4000/api/v1/journeys/<journeyId>/availability?from=NDLS&to=JP"

# Hold one seat on that segment (stop indices come from the search response)
curl -X POST http://localhost:4000/api/bookings \
  -H "Authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
        "trainId": "<uuid>",
        "travelDate": "2027-01-15",
        "fromStopIndex": 0,
        "toStopIndex": 1,
        "passengers": [
          { "name": "Asha Verma", "age": 31, "gender": "FEMALE", "seatId": "<uuid>" }
        ]
      }'

# Open payment (idempotent — repeat calls return the same order)
curl -X POST http://localhost:4000/api/bookings/<id>/payment \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: 3f9c…"
```

### Error contract

Every error — validation, auth, rate limit, 404 — has the same shape:

```json
{
  "error": {
    "message": "Invalid email or password",
    "issues": [{ "path": "email", "message": "Invalid email address" }]
  }
}
```

`issues` is always an array: empty when the error is not field-level.

### Auth notes

- Passwords are hashed with **argon2id** (`memoryCost` 19 MiB, `timeCost` 2). The cost
  parameters are baked into the hash, so raising the cost later does not invalidate
  existing users — re-hash them on their next login.
- Access tokens are **HS256 JWTs** with `sub`, `iat` and `exp`. `JWT_EXPIRES_IN` is a human
  string (`7d`) that is parsed into seconds; `exp` is always numeric Unix seconds.
  The algorithm is pinned on verification, so an `alg: none` token is rejected.
- Login always runs a verify against a real dummy argon2id hash, so "unknown email" and
  "wrong password" take the same time and return the same message.
- `/api/auth/me` re-reads the user from the database: the token proves identity, the
  database decides the current state.
- Register and login are rate limited **per IP and per email**. The per-email counter
  only counts failures, so a successful login never consumes the budget.

> The rate limiter's store is in-process (`MemoryStore`). With more than one instance
> behind a load balancer, each instance keeps its own counters — swap in
> `RedisStore` / `UnstorageStore` before scaling out.

## Train, schedule, journey

Three things that are easy to conflate and expensive to separate later:

| Concept | Row | Answers |
|---|---|---|
| Physical train | `Train` + `TrainStop` | "what route does 12001 take, and how far is each stop?" |
| Timetable | `TrainSchedule` | "does it run on Sundays, at what time, and since/until when?" |
| Dated service | `Journey` + `JourneyClass` | "12001 on 2026-11-01" — the thing you book |

A `Journey` stores **instants**, not clock strings. `date` is the service date;
`departureAt`/`arrivalAt` are `timestamptz`. Timetable strings are IST wall
clock, converted on creation, so an overnight train that leaves Delhi at 21:10
on 1 November and reaches Chennai at 09:40 has `arrivalAt` on 2 November.

Journeys are materialised lazily by the first dated search and are idempotent —
a unique `(trainId, date, runNumber)` plus `createMany({ skipDuplicates: true })`
means two concurrent searches create one row. `JourneyClass` snapshots fares and
inventory at that moment, so changing a price tomorrow does not reprice a
journey already on sale.

`/api/v1` is the canonical prefix for these reads. The same router is also
mounted at `/api` as a legacy alias while the booking and payment endpoints
finish migrating.

## Routes, segments and fares

A train has an ordered route (`TrainStop`, `stopIndex` 0..n). A search is a
question about a **segment**: board at stop `i`, alight at stop `j > i`. A
train only appears in results when it visits both stations in that order —
`from.stopIndex < to.stopIndex`. Stop ranges are half-open, `[from, to)`,
matching `TicketSeat`: alighting at stop 3 and boarding at stop 3 are different
passengers, not a conflict.

Fare is per seat: `baseFare + farePerKm × segmentDistance`, in paise. The
segment distance is `to.distanceKm − from.distanceKm` from the route, so
Delhi → Bhopal does not pay the Delhi → Chennai price. `POST /api/bookings`
accepts the same `fromStopIndex`/`toStopIndex` and charges the same number —
there is a test asserting search and booking agree.

**Availability is derived.** `totalSeats − booked − blocked`:

| Term | Source |
|---|---|
| `totalSeats` | `JourneyClass.totalSeats` (snapshot of `TrainClass`) |
| `booked` | `BookingSeat` rows for that class and travel date |
| `blocked` | `Seat.isAvailable = false` (admin took it out of service) |

Bookings currently hold their seat for the **whole date**, not just the
segment. That is deliberately conservative: it can never oversell, and it means
availability is a simple per-class count. Letting a seat be resold on a
disjoint segment (`A→B` and `B→C` on the same day) is what `JourneySeat` /
`TicketSeat` and the `TicketSeat_no_segment_overlap` constraint are for; wiring
bookings onto them is the next migration.

## Booking and payment

**Occupancy is derived, never stored twice.** `Seat.isAvailable` is operational
state (an admin taking a coach out of service). Whether a seat is free on a date
is answered by `BookingSeat(seatId, travelDate)`, which is `UNIQUE`. A seat is
therefore reusable on every other date, and the database — not application
code — decides who won a race.

**The reservation transaction is short and lock-ordered.** `reserveSeats` takes
`SELECT … FOR UPDATE … ORDER BY id` on the seat rows, re-checks occupancy under
the lock, and writes the booking in the same transaction. Ordering prevents
deadlocks; the unique index is the final backstop. Interactive transactions use
a 20s timeout (`src/db/transaction.ts`) because Neon round trips can exceed
Prisma's 5s default.

**Fare is server-computed.** The client never sends money. The total is
`baseFare + farePerKm × distanceKm` per seat, calculated inside the transaction.

**Holds expire.** A booking is created `PENDING` with `holdExpiresAt` (10 minutes
by default). `sweepExpiredHolds()` — run by cron or `POST /api/admin/sweep-holds`
— takes `FOR UPDATE SKIP LOCKED`, deletes the allocations and marks the booking
`CANCELLED`. It is idempotent and safe to run concurrently with itself.

**Payments are idempotent at three layers:**

1. `Payment.bookingId` is UNIQUE — one live payment per booking, enforced by the
   database even if two requests race.
2. `Idempotency-Key` header pins the result across client retries.
3. `PaymentEvent.providerEventId` is UNIQUE — a replayed webhook is
   `INSERT … ON CONFLICT DO NOTHING`, and "0 rows inserted" is the signal that it
   was already handled. State transitions use compare-and-set on `Payment.version`.

**Webhooks are signed.** `x-webhook-signature` is a hex HMAC-SHA256 of the raw
body, verified in constant time against `PAYMENT_WEBHOOK_SECRET`. An unsigned
event is recorded for forensics but never applied, and returns 401.

**A late payment is never allowed to resurrect a booking.** If the hold has
lapsed — checked against `holdExpiresAt`, not just the status, because the
sweeper runs on a schedule — the payment is recorded, refunded, and the booking
stays `CANCELLED`.

### Constraint → HTTP mapping

| Database outcome | Status | Meaning |
|---|---|---|
| `TicketSeat_no_segment_overlap` (23P01) | `409` | Overlapping journey segments on one seat |
| unique violation (23505) | `409` | Duplicate key: seat taken, email registered, … |
| other integrity violation | `400` | Check / foreign-key rejected the write |
| unknown | `500` | A real bug |

## Scripts

| Script | Does |
|---|---|
| `bun run dev` | Start with hot reload |
| `bun run start` | Start without watch |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Run the test suite (`bun test`) |
| `bun run db:generate` | Regenerate Prisma Client |
| `bun run db:migrate` | Create + apply a migration |
| `bun run db:deploy` | Apply migrations (production) |
| `bun run db:seed` | Seed stations / trains / seats |
| `bun run db:studio` | Prisma Studio GUI |
