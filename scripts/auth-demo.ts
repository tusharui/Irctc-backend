
import { prisma } from "../src/db/client";

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:4000";
const PASSWORD = "Demo-Password-123";
const RUN_ID = Math.random().toString(36).slice(2, 8);
const EMAIL = `demo+${RUN_ID}@example.test`;

let pass = 0;
let fail = 0;

// ── pretty printing ───────────────────────────────────────────────────
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const D = "\x1b[90m";
const B = "\x1b[1m";
const X = "\x1b[0m";

function step(title: string) {
  console.log(`\n${C}${B}${title}${X}`);
  console.log(`${D}${"─".repeat(72)}${X}`);
}

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ${G}PASS${X}  ${label}${detail ? ` ${D}${detail}${X}` : ""}`);
  } else {
    fail++;
    console.log(`  ${R}FAIL${X}  ${label}${detail ? ` ${R}${detail}${X}` : ""}`);
  }
}

function note(text: string) {
  console.log(`  ${D}${text}${X}`);
}

function show(body: unknown) {
  const json = JSON.stringify(body, null, 2)
    .split("\n")
    .map((l) => `  ${D}${l}${X}`)
    .join("\n");
  console.log(json);
}

// ── HTTP helper ───────────────────────────────────────────────────────
async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: any; ms: number }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;

  const started = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = Date.now() - started;

  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, ms };
}

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Split a JWT into its three segments.
 *
 * `noUncheckedIndexedAccess` is on in this project, so array elements
 * are `string | undefined` — TypeScript cannot know the token has
 * exactly three parts. Narrowing explicitly is the point of that flag:
 * it stops a malformed token from silently producing `undefined`.
 */
function splitToken(token: string): { header: string; payload: string; signature: string } {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error(`Not a JWT (expected 3 segments, got ${token.split(".").length})`);
  }
  return { header, payload, signature };
}

// ─────────────────────────────────────────────────────────────────────
// 0. Is the server even up?
// ─────────────────────────────────────────────────────────────────────
step("0. Server reachable?");
try {
  const res = await call("GET", "/health");
  check("GET /health", res.status === 200, `-> ${res.status}`);
} catch (err) {
  console.log(`\n  ${R}Cannot reach ${BASE}${X}`);
  console.log(`  Start the server first:  ${B}bun run dev${X}`);
  console.log(`  ${D}(${(err as Error).message})${X}\n`);
  await prisma.$disconnect();
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// 1. REGISTER
// ─────────────────────────────────────────────────────────────────────
step("1. POST /api/auth/register  (happy path)");
note("Creates the user, hashes the password with argon2id, returns a JWT.");
const reg = await call("POST", "/api/auth/register", {
  email: EMAIL,
  password: PASSWORD,
  name: "Demo User",
});
show(reg.body);
check("status is 201", reg.status === 201, `-> ${reg.status}`);
check("a token was returned", typeof reg.body?.token === "string");
check(
  "the user object has NO passwordHash",
  !("passwordHash" in (reg.body?.user ?? {})),
  `keys: ${Object.keys(reg.body?.user ?? {}).join(", ")}`
);
check("role defaults to CUSTOMER", reg.body?.user?.role === "CUSTOMER");

const token: string = reg.body?.token ?? "";

// ─────────────────────────────────────────────────────────────────────
// 2. WHAT IS INSIDE THE TOKEN?
// ─────────────────────────────────────────────────────────────────────
step("2. Decode the JWT  (it is encoded, NOT encrypted)");
const segments = splitToken(token);
note("Anyone holding the token can read this. That is why secrets never go in it.");
show({ header: decodeSegment(segments.header), payload: decodeSegment(segments.payload) });
const payload = decodeSegment(segments.payload);
check("header alg is HS256", decodeSegment(segments.header).alg === "HS256");
check("payload.sub is the user id", payload.sub === reg.body?.user?.id);
check("payload.exp is a number (Unix seconds)", typeof payload.exp === "number");
const daysOut = (payload.exp - Math.floor(Date.now() / 1000)) / 86400;
check("expires in ~7 days", daysOut > 6.9 && daysOut < 7.1, `-> ${daysOut.toFixed(2)} days`);

// ─────────────────────────────────────────────────────────────────────
// 3. LOGIN
// ─────────────────────────────────────────────────────────────────────
step("3. POST /api/auth/login");
const login = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("status is 200", login.status === 200, `-> ${login.status}`);
check("a token was returned", typeof login.body?.token === "string");
check(
  "the user object has NO passwordHash",
  !("passwordHash" in (login.body?.user ?? {}))
);

// ─────────────────────────────────────────────────────────────────────
// 4. PROTECTED ROUTE
// ─────────────────────────────────────────────────────────────────────
step("4. GET /api/auth/me  (protected)");
const me = await call("GET", "/api/auth/me", undefined, login.body?.token);
show(me.body);
check("200 with the user", me.status === 200);
check("same email", me.body?.user?.email === EMAIL);

// ─────────────────────────────────────────────────────────────────────
// 5. THE TOKEN IS REQUIRED
// ─────────────────────────────────────────────────────────────────────
step("5. GET /api/auth/me  (no token / bad token)");
const noToken = await call("GET", "/api/auth/me");
check("no token -> 401", noToken.status === 401, `-> ${noToken.status}`);
show(noToken.body);

const garbage = await call("GET", "/api/auth/me", undefined, "not.a.jwt");
check("garbage token -> 401", garbage.status === 401, `-> ${garbage.status}`);

// ─────────────────────────────────────────────────────────────────────
// 6. FORGERY
// ─────────────────────────────────────────────────────────────────────
step("6. Tampering with the token");
const tampered = `${segments.header}.${Buffer.from(
  JSON.stringify({ sub: payload.sub, iat: payload.iat, exp: 9999999999 })
).toString("base64url")}.${segments.signature}`;
const tamperedRes = await call("GET", "/api/auth/me", undefined, tampered);
check("payload edited -> 401", tamperedRes.status === 401, `-> ${tamperedRes.status}`);

const algNone = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
  "base64url"
)}.${segments.payload}.`;
const algNoneRes = await call("GET", "/api/auth/me", undefined, algNone);
check('"alg":"none" -> 401', algNoneRes.status === 401, `-> ${algNoneRes.status}`);

// ─────────────────────────────────────────────────────────────────────
// 7. DUPLICATE EMAIL
// ─────────────────────────────────────────────────────────────────────
step("7. Registering the same email again");
const dup = await call("POST", "/api/auth/register", {
  email: EMAIL,
  password: PASSWORD,
  name: "Demo User",
});
check("status is 409 Conflict", dup.status === 409, `-> ${dup.status}`);
show(dup.body);

// ─────────────────────────────────────────────────────────────────────
// 8. VALIDATION
// ─────────────────────────────────────────────────────────────────────
step("8. Invalid input");
const bad = await call("POST", "/api/auth/register", { email: "nope", password: "x", name: "" });
check("status is 400", bad.status === 400, `-> ${bad.status}`);
check(
  "every offending field is named",
  ["email", "password", "name"].every((f) =>
    bad.body?.error?.issues?.some((i: any) => i.path === f)
  ),
  `-> ${bad.body?.error?.issues?.map((i: any) => i.path).join(", ")}`
);
show(bad.body);

// ─────────────────────────────────────────────────────────────────────
// 9. NO USER ENUMERATION
// ─────────────────────────────────────────────────────────────────────
step("9. Wrong password vs unknown email  (must be indistinguishable)");
const wrongPw = await call("POST", "/api/auth/login", {
  email: EMAIL,
  password: "Totally-Wrong-9",
});
const noSuch = await call("POST", "/api/auth/login", {
  email: `ghost+${RUN_ID}@example.test`,
  password: PASSWORD,
});
check("wrong password -> 401", wrongPw.status === 401);
check("unknown email  -> 401", noSuch.status === 401);
check(
  "identical message",
  wrongPw.body?.error?.message === noSuch.body?.error?.message,
  `-> "${wrongPw.body?.error?.message}"`
);
note(
  `timing: wrong password ${wrongPw.ms}ms | unknown email ${noSuch.ms}ms ` +
    `(the dummy-hash defence keeps these close)`
);

// ─────────────────────────────────────────────────────────────────────
// 10. RATE LIMITING
// ─────────────────────────────────────────────────────────────────────
step("10. Rate limiting  (per-IP, 30 per 5 minutes)");
let sawLimit = false;
let firstAt = -1;
for (let i = 0; i < 32; i++) {
  const res = await call("POST", "/api/auth/login", {
    email: `rl+${RUN_ID}-${i}@example.test`,
    password: "",
  });
  if (res.status === 429) {
    if (firstAt === -1) firstAt = i;
    sawLimit = true;
  }
}
check("a 429 eventually appears", sawLimit, firstAt >= 0 ? `-> first at request #${firstAt + 1}` : "");
note("The counters are in server memory. Restart `bun run dev` to reset them instantly.");

// ─────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────
step("Cleanup");
const removed = await prisma.user.deleteMany({ where: { email: EMAIL } });
check("demo user deleted", removed.count === 1, `-> ${removed.count} row(s)`);
await prisma.$disconnect();

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${B}${D}${"═".repeat(72)}${X}`);
console.log(
  `${B}  ${pass} passed, ${fail} failed${X}` +
    (fail === 0 ? `  ${G}— everything behaves correctly${X}` : `  ${R}— something is wrong${X}`)
);
console.log(`${D}${"═".repeat(72)}${X}\n`);
process.exit(fail === 0 ? 0 : 1);
