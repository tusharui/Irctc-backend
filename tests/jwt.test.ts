import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { env } from "../src/env";
import { InvalidTokenError, parseExpiresIn, signAccessToken, verifyAccessToken } from "../src/lib/jwt";

/** Decode a JWT payload the way a client would: base64url, no crypto. */
function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

describe("parseExpiresIn", () => {
  test("parses the human formats", () => {
    expect(parseExpiresIn("30s")).toBe(30);
    expect(parseExpiresIn("15m")).toBe(900);
    expect(parseExpiresIn("24h")).toBe(86400);
    expect(parseExpiresIn("7d")).toBe(604800);
    expect(parseExpiresIn("2w")).toBe(1209600);
  });

  test("treats a bare number as seconds", () => {
    expect(parseExpiresIn("3600")).toBe(3600);
  });

  test("rejects nonsense", () => {
    expect(() => parseExpiresIn("7 days")).toThrow();
    expect(() => parseExpiresIn("0d")).toThrow();
    expect(() => parseExpiresIn("")).toThrow();
  });
});

describe("signAccessToken", () => {
  test("returns a three-part token", async () => {
    const token = await signAccessToken({ sub: "user-123" });

    expect(token.split(".")).toHaveLength(3);
  });

  test("payload carries sub, exp and iat", async () => {
    const token = await signAccessToken({ sub: "user-123" });
    const payload = decodePayload(token);

    expect(payload.sub).toBe("user-123");
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.iat).toBe("number");
  });

  test("exp is a plausible Unix timestamp in seconds", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({ sub: "user-123" });
    const payload = decodePayload(token);

    const exp = payload.exp as number;
    const iat = payload.iat as number;

    // Seconds, not milliseconds: a ms timestamp would be ~1e12.
    expect(exp).toBeGreaterThan(before);
    expect(exp).toBeLessThan(before + 60 * 60 * 24 * 8);
    expect(iat).toBeGreaterThanOrEqual(before - 1);

    // And it is a real date, not a typo.
    expect(new Date(exp * 1000).getUTCFullYear()).toBeGreaterThan(2020);
  });

  test("honours JWT_EXPIRES_IN", async () => {
    const token = await signAccessToken({ sub: "user-123" });
    const payload = decodePayload(token);

    const lifetime = (payload.exp as number) - (payload.iat as number);

    expect(lifetime).toBe(parseExpiresIn(env.JWT_EXPIRES_IN));
  });

  test("the payload is readable, so it must hold no secrets", async () => {
    const token = await signAccessToken({ sub: "user-123" });
    const payload = decodePayload(token);

    // Anyone can decode a JWT — it is encoded, not encrypted.
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "sub"]);
  });
});

describe("verifyAccessToken", () => {
  test("accepts a token it signed", async () => {
    const token = await signAccessToken({ sub: "user-123" });

    const payload = await verifyAccessToken(token);

    expect(payload.sub).toBe("user-123");
    expect(typeof payload.exp).toBe("number");
  });

  test("rejects a token signed with a different secret", async () => {
    const forged = await sign({ sub: "user-123", exp: Math.floor(Date.now() / 1000) + 60 }, "a-completely-different-secret", "HS256");

    await expect(verifyAccessToken(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test("rejects a tampered token", async () => {
    const token = await signAccessToken({ sub: "user-123" });
    const [header, payload, signature] = token.split(".");

    const tampered = `${header}.${payload}.${signature!.slice(0, -2)}xx`;

    await expect(verifyAccessToken(tampered)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test("rejects garbage", async () => {
    await expect(verifyAccessToken("not-a-token")).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifyAccessToken("")).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test("rejects an expired token", async () => {
    const expired = await sign(
      { sub: "user-123", iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
      env.JWT_SECRET,
      "HS256"
    );

    await expect(verifyAccessToken(expired)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test("rejects the 'alg: none' downgrade", async () => {
    // The algorithm-confusion attack: a token that claims no signature.
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=/g, "");
    const body = btoa(
      JSON.stringify({ sub: "user-123", exp: Math.floor(Date.now() / 1000) + 60 })
    ).replace(/=/g, "");

    await expect(verifyAccessToken(`${header}.${body}.`)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
