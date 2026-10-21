import { afterAll, describe, expect, test } from "bun:test";
import { app } from "../src/app";
import { prisma } from "../src/db/client";

// The API error contract:
//   { error: { message: string, issues: [{ path, message }] } }

type ErrorBody = {
  error: {
    message: string;
    issues: { path: string; message: string }[];
  };
};

const register = (body: unknown) =>
  app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// One of these tests registers a real user (to prove the success path
// is not short-circuited) — clean it up again.
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: "@example.test" } } });
});

describe("POST /api/auth/register", () => {
  test("rejects a bad email with 400 and a field-level issue", async () => {
    const res = await register({
      email: "not-an-email",
      password: "supersecret",
      name: "Ashwini",
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.issues[0]?.path).toBe("email");
    expect(body.error.message).toBe("Validation failed");
  });

  test("does not leak the raw ZodError body", async () => {
    const res = await register({ email: "nope", password: "short", name: "" });

    const body = (await res.json()) as Record<string, unknown>;

    // The raw validator answers with { success: false, error: ZodError }.
    // Only "error" (our shape) may be present.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("error.issues[0].code");
  });

  test("reports every offending field, not just the first", async () => {
    const res = await register({ email: "nope", password: "short", name: "" });

    const body = (await res.json()) as ErrorBody;
    const paths = body.error.issues.map((issue) => issue.path);

    expect(paths).toContain("email");
    expect(paths).toContain("password");
    expect(paths).toContain("name");
  });

  test("issues always carry a path and a message", async () => {
    const res = await register({ email: "nope", password: "supersecret", name: "A" });

    const body = (await res.json()) as ErrorBody;

    for (const issue of body.error.issues) {
      expect(typeof issue.path).toBe("string");
      expect(issue.path.length).toBeGreaterThan(0);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  test("a valid body reaches the handler (hook returns undefined on success)", async () => {
    const res = await register({
      email: `valid-${Date.now()}@example.test`,
      password: "supersecret",
      name: "Ashwini",
    });

    // NOT 400 — proof the success path is not short-circuited by the
    // validator hook. (Register now really creates the user, so this
    // is a 201.)
    expect(res.status).not.toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("error");
  });

  test("malformed JSON is rejected with the same error shape", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    // Unparseable bodies never reach Zod — Hono raises an HTTPException,
    // which app.onError reshapes into the same canonical body.
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(typeof body.error.message).toBe("string");
    expect(Array.isArray(body.error.issues)).toBe(true);
  });
});
