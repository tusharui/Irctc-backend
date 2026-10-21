import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/client";
import { signAccessToken } from "../../lib/jwt";
import { hashPassword, verifyPassword } from "../../lib/password";
import { zValidator } from "../../lib/validation";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import { perEmailRateLimit, perIpRateLimit } from "../../middleware/rate-limit";
import { loginSchema, registerSchema } from "./auth.schemas";
import { publicUserSelect } from "./user.select";

export const authRoutes = new Hono<{ Variables: AuthVariables }>();


const DUMMY_PASSWORD_HASH = await hashPassword(
  "dummy-password-used-only-to-equalise-login-timing"
);


function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}


authRoutes.post(
  "/api/auth/register",
  perIpRateLimit,
  perEmailRateLimit,
  zValidator("json", registerSchema),
  async (c) => {
    const { email, password, name } = c.req.valid("json");

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new HTTPException(409, { message: "Email already registered" });
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await prisma.user.create({
        data: { email, passwordHash, name },
        select: publicUserSelect,
      });
    } catch (err) {
      
      if (isUniqueConstraintViolation(err)) {
        throw new HTTPException(409, { message: "Email already registered" });
      }
      throw err;
    }

    const token = await signAccessToken({ sub: user.id });

    return c.json({ user, token }, 201);
  }
);


authRoutes.post(
  "/api/auth/login",
  perIpRateLimit,
  perEmailRateLimit,
  zValidator("json", loginSchema),
  async (c) => {
    const { email, password } = c.req.valid("json");

    const row = await prisma.user.findUnique({
      where: { email },
      select: { ...publicUserSelect, passwordHash: true },
    });

    
    const hash = row?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(password, hash);

    if (!row || !passwordMatches) {
      
      throw new HTTPException(401, { message: "Invalid email or password" });
    }

    
    const { passwordHash: _passwordHash, ...user } = row;

    const token = await signAccessToken({ sub: user.id });

    return c.json({ user, token });
  }
);


authRoutes.get("/api/auth/me", requireAuth, async (c) => {
  const { sub } = c.get("user");

  
  const user = await prisma.user.findUnique({
    where: { id: sub },
    select: publicUserSelect,
  });

  if (!user) {
    throw new HTTPException(401, { message: "Account no longer exists" });
  }

  return c.json({ user });
});
