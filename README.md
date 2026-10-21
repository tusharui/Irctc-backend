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

```bash
# Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You"}'

# Use the token
curl http://localhost:4000/api/auth/me -H "Authorization: Bearer <token>"
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
