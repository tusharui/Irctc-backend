import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db/client";
import { zValidator } from "../../lib/validation";
import type { AuthVariables } from "../../middleware/auth";
import { stationSearchQuerySchema } from "../station/station.schemas";

export const stationRoutes = new Hono<{ Variables: AuthVariables }>();


stationRoutes.get(
  "/stations",
  zValidator("query", stationSearchQuerySchema),
  async (c) => {
    const { search, limit } = c.req.valid("query");

    const stations = await prisma.station.findMany({
      where: search
        ? {
            OR: [
              { code: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { city: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined,
      select: {
        id: true,
        code: true,
        name: true,
        city: true,
        state: true,
        zone: true,
      },
      orderBy: { code: "asc" },
      take: limit,
    });

    return c.json({ count: stations.length, stations });
  }
);
