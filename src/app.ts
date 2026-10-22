import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { isExclusionViolation, isIntegrityViolation, isUniqueViolation } from "./db/errors";
import { errorBody } from "./lib/validation";
import type { AuthVariables } from "./middleware/auth";
import { authRoutes } from "./modules/auth/auth.routes";
import { bookingRoutes } from "./modules/booking/booking.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { paymentRoutes } from "./modules/payment/payment.routes";
import { systemRoutes } from "./modules/system/system.routes";
import { stationRoutes } from "./modules/station/station.routes";
import { trainRoutes } from "./modules/train/train.routes";


export function createApp() {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("*", logger());
  app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: true }));

  
  app.route("/", healthRoutes);
  app.route("/", systemRoutes);
  app.route("/", authRoutes);
  app.route("/", bookingRoutes);
  app.route("/", paymentRoutes);

  // Train/route reads are the first versioned surface. `/api` stays mounted as
  // a legacy alias so older clients keep working while the rest of the API
  // moves to `/api/v1`.
  app.route("/api/v1", stationRoutes);
  app.route("/api/v1", trainRoutes);
  app.route("/api", stationRoutes);
  app.route("/api", trainRoutes);

  app.notFound((c) => c.json(errorBody("Route not found"), 404));

  app.onError((err, c) => {
   
    if (err instanceof HTTPException) {
      return c.json(errorBody(err.message || `HTTP ${err.status}`), err.status);
    }

    // Constraint violations are a normal outcome under concurrency, not a
    // bug: translate the database's "no" into a precise client error.
    if (isExclusionViolation(err)) {
      return c.json(errorBody("Seat already reserved for this segment"), 409);
    }
    if (isUniqueViolation(err)) {
      return c.json(errorBody("Duplicate record"), 409);
    }
    if (isIntegrityViolation(err)) {
      return c.json(errorBody("Request violates a data constraint"), 400);
    }

    console.error("Unhandled error:", err);
    return c.json(errorBody("Internal server error"), 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;


export const app = createApp();
