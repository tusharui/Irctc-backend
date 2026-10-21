import { app } from "./app";
import { prisma } from "./db/client";
import { env } from "./env";


async function listen(retries = 10): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return Bun.serve({ port: env.PORT, fetch: app.fetch });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "EADDRINUSE" || attempt > retries) throw err;
      await Bun.sleep(200);
    }
  }
}

const server = await listen();

console.log(`🚀 irctc-backend listening on http://localhost:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down...`);
    await server.stop(true);
    await prisma.$disconnect();
    process.exit(0);
  });
}
