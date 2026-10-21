import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { env } from "../env";
import { errorBody } from "../lib/validation";


const IP_LIMIT = 30;
const IP_WINDOW_MS = 5 * 60 * 1000;

const EMAIL_LIMIT = 10;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;


function resolveClientIp(c: Context): string {
  const server = c.env as
    | { requestIP?: (request: Request) => { address: string } | null }
    | undefined;

  const info = server?.requestIP?.(c.req.raw);
  if (info?.address) return info.address;

  if (env.NODE_ENV !== "production") {
    const forwarded = c.req.header("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}


async function emailFromBody(c: Context): Promise<string | undefined> {
  try {
    const body = (await c.req.json()) as { email?: unknown } | null;
    const email = body?.email;
    return typeof email === "string" ? email.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const tooManyRequests = (c: Context) =>
  c.json(errorBody("Too many requests, please try again later."), 429);


export const perIpRateLimit = rateLimiter({
  windowMs: IP_WINDOW_MS,
  limit: IP_LIMIT,
  keyGenerator: (c) => resolveClientIp(c),
  handler: (c) => tooManyRequests(c),
});


export const perEmailRateLimit = rateLimiter({
  windowMs: EMAIL_WINDOW_MS,
  limit: EMAIL_LIMIT,
  keyGenerator: async (c) => {
    const email = await emailFromBody(c);
    
    return email ? `email:${email}` : `email:unknown:${resolveClientIp(c)}`;
  },
  skipSuccessfulRequests: true,
  handler: (c) => tooManyRequests(c),
});
