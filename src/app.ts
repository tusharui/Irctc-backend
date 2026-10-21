import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { errorBody } from "./lib/validation";
import type { AuthVariables } from "./middleware/auth";
import { authRoutes } from "./modules/auth/auth.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { systemRoutes } from "./modules/system/system.routes";


export function createApp() {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("*", logger());
  app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: true }));

  
  app.route("/", healthRoutes);
  app.route("/", systemRoutes);
  app.route("/", authRoutes);

  app.notFound((c) => c.json(errorBody("Route not found"), 404));

  app.onError((err, c) => {
   
    if (err instanceof HTTPException) {
      return c.json(errorBody(err.message || `HTTP ${err.status}`), err.status);
    }

    console.error("Unhandled error:", err);
    return c.json(errorBody("Internal server error"), 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;


export const app = createApp();
