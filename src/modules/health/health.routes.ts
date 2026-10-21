import { Hono } from "hono";
import type { AuthVariables } from "../../middleware/auth";

export const healthRoutes = new Hono<{ Variables: AuthVariables }>();

healthRoutes.get("/health", (c) =>
  c.json({ status: "ok", service: "irctc-backend", timestamp: new Date().toISOString() })
);
