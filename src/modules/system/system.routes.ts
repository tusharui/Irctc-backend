import { Hono } from "hono";
import { prisma } from "../../db/client";
import type { AuthVariables } from "../../middleware/auth";

export const systemRoutes = new Hono<{ Variables: AuthVariables }>();

systemRoutes.get("/api/db-check", async (c) => {
  const users = await prisma.user.count();
  const stations = await prisma.station.count();
  return c.json({ ok: true, users, stations });
});
