import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../db/client";
import { InvalidTokenError, verifyAccessToken, type JwtPayload } from "../lib/jwt";



export type AuthVariables = {
  user: JwtPayload;
};

type AuthEnv = { Variables: AuthVariables };


async function authenticate(c: Context): Promise<JwtPayload> {
  const header = c.req.header("Authorization");

  if (!header) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const [scheme, token] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new HTTPException(401, { message: "Invalid authorization header" });
  }

  try {
    return await verifyAccessToken(token);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      throw new HTTPException(401, { message: "Invalid or expired token" });
    }
    throw err;
  }
}


export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  c.set("user", await authenticate(c));
  await next();
};


export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const authenticated = c.get("user") as JwtPayload | undefined;
  const payload = authenticated ?? (await authenticate(c));

  const account = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { role: true },
  });

  if (!account) {
    throw new HTTPException(401, { message: "Account no longer exists" });
  }

  if (account.role !== "ADMIN") {
    throw new HTTPException(403, { message: "Admin access required" });
  }

  // Put the payload on the context so downstream handlers can read
  // c.get("user") even when requireAdmin runs without requireAuth.
  c.set("user", payload);

  await next();
};
