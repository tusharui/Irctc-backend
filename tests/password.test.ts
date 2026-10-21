import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../src/lib/password";

describe("hashPassword", () => {
  test("produces an argon2id hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  test("bakes the cost parameters into the hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    // $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
  });

  test("two hashes of the same password are different (the salt works)", async () => {
    const a = await hashPassword("correct-horse-battery-staple");
    const b = await hashPassword("correct-horse-battery-staple");

    expect(a).not.toBe(b);
  });

  test("never contains the plaintext", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(hash).not.toContain("correct-horse-battery-staple");
  });
});

describe("verifyPassword", () => {
  test("accepts the correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  test("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  test("rejects an empty password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(await verifyPassword("", hash)).toBe(false);
  });

  test("returns false for a malformed hash instead of throwing", async () => {
    // Bun.password.verify THROWS on a malformed hash. A caller must
    // never see that throw: a corrupt row must look like a wrong
    // password, not a 500.
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "$argon2id$broken")).toBe(false);
  });

  test("a hash made with a different cost still verifies", async () => {
    // The cost is read from the hash string, so raising the cost later
    // does not invalidate existing users' passwords.
    const cheap = await Bun.password.hash("correct-horse-battery-staple", {
      algorithm: "argon2id",
      memoryCost: 8192,
      timeCost: 1,
    });

    expect(await verifyPassword("correct-horse-battery-staple", cheap)).toBe(true);
  });
});
