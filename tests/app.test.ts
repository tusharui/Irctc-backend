import { describe, expect, test } from "bun:test";
import { app } from "../src/app";

// These tests never open a port. `app.request()` runs the full Hono
// stack (middleware -> route -> error handling) in-process and hands back
// a real Response, exactly like a live HTTP call would.

describe("GET /health", () => {
  test("returns 200 with an ok payload", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("irctc-backend");
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });
});

describe("unknown routes", () => {
  test("returns 404 with a JSON error body", async () => {
    const res = await app.request("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { message: "Route not found", issues: [] },
    });
  });
});
