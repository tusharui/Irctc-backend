import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "bun prisma/seed.ts",
  },
  datasource: {
    // NOTE: the DIRECT (non-pooled) URL, not DATABASE_URL.
    // Prisma Migrate runs DDL and creates a shadow database, which a
    // pooled (PgBouncer) connection cannot do.
    url: env("DIRECT_DATABASE_URL"),
  },
});
