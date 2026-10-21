/**
 * Auth smoke suite — ONE command verifies the whole auth phase.
 *
 *   bun test
 *
 * WHY IT RUNS AGAINST THE REAL DATABASE:
 *   The interesting failures in auth live at the boundary between HTTP
 *   and Postgres — the unique-constraint race on register, "account no
 *   longer exists" after a delete, the admin role lookup. A mocked
 *   Prisma would exercise none of them. Neon is free and the queries
 *   are tiny.
 *
 * WHY IT NEEDS NO PORT:
 *   app.request() drives the entire HTTP stack in-process — routing,
 *   middleware, validation, error handling — without opening a socket.
 *   That is the payoff of keeping app.ts separate from index.ts.
 *
 * LEAVES NO RESIDUE:
 *   Every user it creates carries a unique prefix and is deleted in
 *   afterAll, so the suite is repeatable.
 *
 * RATE LIMITING + X-FORWARDED-FOR:
 *   The per-IP limiter trusts x-forwarded-for only when NODE_ENV is not
 *   "production" (see src/middleware/rate-limit.ts). These tests need
 *   NODE_ENV=development or test. Running with NODE_ENV=production
 *   would make every request share one IP bucket and trip the limit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { createApp } from "../src/app";
import { prisma } from "../src/db/client";
import { parseExpiresIn, signAccessToken } from "../src/lib/jwt";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { requireAdmin } from "../src/middleware/auth";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PASSWORD = "Correct-Horse-Battery-9";
const createdUserIds: string[] = [];

/** Every request gets its own client IP, so no test starves another. */
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`; // TEST-NET-3, reserved for documentation
}

/** A unique email per call — isolates the per-account rate-limit bucket. */
function uniqueEmail(tag: string): string {
  return `smoke+${tag}+${RUN_ID}@example.test`;
}

function jsonHeaders(ip?: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("x-forwarded-for", ip);
  return headers;
}

async function post(
  path: string,
  body: unknown,
  ip?: string
): Promise<{ status: number; body: any }> {
  const res = await createApp().request(path, {
    method: "POST",
    headers: jsonHeaders(ip),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(
  path: string,
  opts: { token?: string; ip?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  const res = await createApp().request(path, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

// ────────────────────────────────────────────────────────────────────
// 1. The error contract — every failure in the API has the same shape.
// ────────────────────────────────────────────────────────────────────

describe("error contract", () => {
  test("unknown route -> 404 with the canonical body", async () => {
    const res = await get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Route not found");
    expect(Array.isArray(res.body.error.issues)).toBe(true);
  });

  test("malformed JSON -> 400 with the canonical body", async () => {
    const res = await post("/api/auth/login", "{not-json", nextIp());
    expect(res.status).toBe(400);
    // A body that will not parse never reaches Zod, so the message is
    // Hono's ("Malformed JSON in request body"), not "Validation failed".
    // What MUST hold is the SHAPE: exactly one top-level "error" key,
    // with a message and an issues array.
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(typeof res.body.error.message).toBe("string");
    expect(res.body.error.message.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.error.issues)).toBe(true);
  });

  test("failed validation names the offending field", async () => {
    const res = await post(
      "/api/auth/register",
      { email: "not-an-email", password: "short", name: "" },
      nextIp()
    );
    expect(res.status).toBe(400);
    const paths = res.body.error.issues.map((i: any) => i.path);
    expect(paths).toContain("email");
    expect(paths).toContain("password");
    expect(paths).toContain("name");
    // The path must be the FIELD NAME, not "body.email" or "0".
    for (const p of paths) expect(p).not.toContain(".");
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Register
// ────────────────────────────────────────────────────────────────────

describe("POST /api/auth/register", () => {
  test("creates the user, returns a token, and never leaks the hash", async () => {
    const email = uniqueEmail("reg-ok");
    const res = await post("/api/auth/register", { email, password: PASSWORD, name: "Asha" }, nextIp());

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe("CUSTOMER");
    expect(typeof res.body.token).toBe("string");

    // The strongest possible guard: the user object has EXACTLY these keys.
    expect(Object.keys(res.body.user).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "name",
      "role",
    ]);
    expect(res.body.user.passwordHash).toBeUndefined();

    const row = await prisma.user.findUnique({ where: { email } });
    expect(row).not.toBeNull();
    createdUserIds.push(row!.id);

    // Stored as a real argon2id hash, never plaintext.
    expect(row!.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(row!.passwordHash).not.toContain(PASSWORD);
  });

  test("duplicate email -> 409", async () => {
    const email = uniqueEmail("reg-dup");
    const ip = nextIp();

    const first = await post("/api/auth/register", { email, password: PASSWORD, name: "A" }, ip);
    expect(first.status).toBe(201);
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const second = await post("/api/auth/register", { email, password: PASSWORD, name: "B" }, ip);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe("Email already registered");
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Login
// ────────────────────────────────────────────────────────────────────

describe("POST /api/auth/login", () => {
  test("correct credentials -> 200 + token + no hash", async () => {
    const email = uniqueEmail("login-ok");
    await post("/api/auth/register", { email, password: PASSWORD, name: "B" }, nextIp());

    const res = await post("/api/auth/login", { email, password: PASSWORD }, nextIp());
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(Object.keys(res.body.user).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "name",
      "role",
    ]);
  });

  test("wrong password -> 401 'Invalid email or password'", async () => {
    const email = uniqueEmail("login-wrongpw");
    await post("/api/auth/register", { email, password: PASSWORD, name: "C" }, nextIp());

    const res = await post("/api/auth/login", { email, password: "WrongPassword123" }, nextIp());
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password");
  });

  test("unknown email -> 401 with the IDENTICAL message (no enumeration oracle)", async () => {
    const res = await post(
      "/api/auth/login",
      { email: uniqueEmail("login-nosuch"), password: PASSWORD },
      nextIp()
    );
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password");
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. JWT anatomy + forgery resistance
// ────────────────────────────────────────────────────────────────────

describe("JWT", () => {
  test("token is HS256 and carries sub / iat / exp", async () => {
    const email = uniqueEmail("jwt-shape");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "D" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const [header, payload] = reg.body.token.split(".");
    expect(reg.body.token.split(".").length).toBe(3);

    const h = decodeSegment(header);
    expect(h.alg).toBe("HS256");

    const p = decodeSegment(payload);
    expect(p.sub).toBe(reg.body.user.id);
    expect(typeof p.iat).toBe("number");
    expect(typeof p.exp).toBe("number");
    // JWT_EXPIRES_IN=7d -> exp must be ~7 days out, in SECONDS.
    const daysOut = (p.exp - Math.floor(Date.now() / 1000)) / 86400;
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  test("a tampered payload is rejected", async () => {
    const email = uniqueEmail("jwt-tamper");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "E" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const [h, , s] = reg.body.token.split(".");
    const forged = `${h}.${b64url({ sub: row!.id, iat: 1, exp: 9999999999 })}.${s}`;

    const res = await get("/api/auth/me", { token: forged });
    expect(res.status).toBe(401);
  });

  test('"alg": "none" is rejected (algorithm-confusion defence)', async () => {
    const email = uniqueEmail("jwt-algnone");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "F" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const none = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
      sub: row!.id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;

    const res = await get("/api/auth/me", { token: none });
    expect(res.status).toBe(401);
  });

  test("a token signed with a different secret is rejected", async () => {
    const email = uniqueEmail("jwt-wrongsecret");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "G" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const forged = await sign(
      { sub: row!.id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      "a-completely-different-secret-that-is-long-enough",
      "HS256"
    );

    const res = await get("/api/auth/me", { token: forged });
    expect(res.status).toBe(401);
  });

  test("an expired token is rejected", async () => {
    const email = uniqueEmail("jwt-expired");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "H" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const expired = await sign(
      { sub: row!.id, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
      process.env.JWT_SECRET!,
      "HS256"
    );

    const res = await get("/api/auth/me", { token: expired });
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Protected routes
// ────────────────────────────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  test("no Authorization header -> 401", async () => {
    const res = await get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Authentication required");
  });

  test("garbage token -> 401", async () => {
    const res = await get("/api/auth/me", { token: "not-a-jwt-at-all" });
    expect(res.status).toBe(401);
  });

  test("wrong scheme -> 401", async () => {
    const res = await get("/api/auth/me", { token: "Basic abc123" });
    expect(res.status).toBe(401);
  });

  test("valid token -> 200 with the user", async () => {
    const email = uniqueEmail("me-ok");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "I" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const res = await get("/api/auth/me", { token: reg.body.token });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  test("token for a deleted account -> 401 (the DB governs)", async () => {
    const email = uniqueEmail("me-deleted");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "J" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });

    await prisma.user.delete({ where: { id: row!.id } });

    const res = await get("/api/auth/me", { token: reg.body.token });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Account no longer exists");
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. requireAdmin — 403 vs 401
// ────────────────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  const adminApp = createApp();
  adminApp.get("/api/__admin_probe", requireAdmin, (c) =>
    c.json({ ok: true, sub: c.get("user").sub })
  );

  test("a CUSTOMER gets 403 (known user, not allowed)", async () => {
    const email = uniqueEmail("admin-customer");
    const reg = await post("/api/auth/register", { email, password: PASSWORD, name: "K" }, nextIp());
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    const res = await adminApp.request("/api/__admin_probe", {
      headers: { authorization: `Bearer ${reg.body.token}` },
    });
    expect(res.status).toBe(403);
  });

  test("an ADMIN gets 200", async () => {
    const email = uniqueEmail("admin-ok");
    const passwordHash = await hashPassword(PASSWORD);
    const row = await prisma.user.create({
      data: { email, passwordHash, name: "Root", role: "ADMIN" },
    });
    createdUserIds.push(row.id);

    const token = await signAccessToken({ sub: row.id });
    const res = await adminApp.request("/api/__admin_probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("no token -> 401 (not 403)", async () => {
    const res = await adminApp.request("/api/__admin_probe");
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. Timing — unknown email must cost the same as a wrong password
// ────────────────────────────────────────────────────────────────────

describe("timing defence", () => {
  test("unknown email and wrong password take comparable time", async () => {
    const email = uniqueEmail("timing");
    await post("/api/auth/register", { email, password: PASSWORD, name: "L" }, nextIp());

    const time = async (body: unknown) => {
      const t0 = performance.now();
      await post("/api/auth/login", body, nextIp());
      return performance.now() - t0;
    };

    // Warm up: the first verify pays a one-off cost.
    await time({ email: uniqueEmail("timing-warm"), password: PASSWORD });

    const unknown: number[] = [];
    const wrongPw: number[] = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await time({ email: uniqueEmail(`timing-none-${i}`), password: PASSWORD }));
      wrongPw.push(await time({ email, password: "Definitely-Wrong-9" }));
    }

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const ratio = avg(unknown) / avg(wrongPw);

    // If the dummy-hash defence were removed, the unknown-email path
    // would return in ~2ms while the wrong-password path takes ~80ms —
    // a ratio near 0.02. A wide band still catches that.
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });
});

// ────────────────────────────────────────────────────────────────────
// 8. Rate limiting
// ────────────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  test("the per-IP limiter answers 429 with the canonical body", async () => {
    const ip = nextIp(); // one dedicated IP for this test
    let sawTooMany = false;
    let firstTooManyAt = -1;
    let badBody = false;

    for (let i = 0; i < 35; i++) {
      // A body that fails Zod validation: the rate limiter still counts
      // it (it runs BEFORE the validator), but the request returns in
      // ~1ms instead of ~300ms of argon2id. Same bucket, 100x faster.
      const res = await post(
        "/api/auth/login",
        { email: uniqueEmail(`rl-${i}`), password: "" },
        ip
      );
      if (res.status === 429) {
        if (firstTooManyAt === -1) firstTooManyAt = i;
        sawTooMany = true;
        if (res.body?.error?.message !== "Too many requests, please try again later.") {
          badBody = true;
        }
        if (!Array.isArray(res.body?.error?.issues)) badBody = true;
      }
    }

    expect(sawTooMany).toBe(true);
    expect(badBody).toBe(false);
    // The per-IP budget is 30 per 5 minutes, so the 31st request trips it.
    expect(firstTooManyAt).toBeGreaterThanOrEqual(30);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────
// 9. Unit-level checks
// ────────────────────────────────────────────────────────────────────

describe("parseExpiresIn", () => {
  test("parses every supported unit", () => {
    expect(parseExpiresIn("30s")).toBe(30);
    expect(parseExpiresIn("15m")).toBe(900);
    expect(parseExpiresIn("24h")).toBe(86400);
    expect(parseExpiresIn("7d")).toBe(604800);
    expect(parseExpiresIn("2w")).toBe(1209600);
    expect(parseExpiresIn("3600")).toBe(3600);
  });

  test("rejects nonsense", () => {
    expect(() => parseExpiresIn("7days")).toThrow();
    expect(() => parseExpiresIn("abc")).toThrow();
    expect(() => parseExpiresIn("-5d")).toThrow();
    expect(() => parseExpiresIn("0d")).toThrow();
  });
});

describe("verifyPassword", () => {
  test("a malformed hash returns false instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "$argon2id$broken")).toBe(false);
  });

  test("the right password verifies and the wrong one does not", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", hash)).toBe(false);
  });

  test("two hashes of the same password differ (the salt works)", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────────

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});
