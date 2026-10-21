import { sign, verify } from "hono/jwt";
import { env } from "../env";


export interface JwtPayload {
  sub: string;
  exp: number;
  iat: number;
}

const ALGORITHM = "HS256";

export class InvalidTokenError extends Error {
  constructor(message = "Token is invalid or expired") {
    super(message);
    this.name = "InvalidTokenError";
  }
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};


export function parseExpiresIn(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(value.trim());

  const amount = match?.[1];
  const unit = (match?.[2] ?? "s").toLowerCase();
  const multiplier = UNIT_SECONDS[unit];

  if (amount === undefined || multiplier === undefined) {
    throw new Error(`Invalid JWT_EXPIRES_IN: "${value}" (expected e.g. "30s", "15m", "24h", "7d")`);
  }

  const seconds = Number(amount) * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid JWT_EXPIRES_IN: "${value}" (must be a positive duration)`);
  }

  return seconds;
}

function expiresInSeconds(): number {
  return parseExpiresIn(env.JWT_EXPIRES_IN);
}


export async function signAccessToken(payload: { sub: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return sign(
    {
      sub: payload.sub,
      iat: now,
      exp: now + expiresInSeconds(),
    },
    env.JWT_SECRET,
    ALGORITHM
  );
}


export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  let payload: Record<string, unknown>;

  try {
    payload = await verify(token, env.JWT_SECRET, { alg: ALGORITHM });
  } catch {
    throw new InvalidTokenError();
  }

  const { sub, exp, iat } = payload;

  
  if (typeof sub !== "string" || typeof exp !== "number") {
    throw new InvalidTokenError("Token payload is malformed");
  }

  return {
    sub,
    exp,
    iat: typeof iat === "number" ? iat : exp,
  };
}
