import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { buildServer } from "./server.js";

const cfg = loadConfig();
const ctx = buildContext(cfg);
const app = await buildServer(ctx);
// Don't let a database problem stop the server from booting: /health/ready and the logs report it.
if (ctx.supabase && cfg.OWNER_EMAIL) {
  await ctx.supabase.ensureOwner(cfg.OWNER_EMAIL).catch((err) => app.log.error({ err: (err as Error).message }, "Could not register the dashboard owner in Supabase"));
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, "shutting down");
    await app.close();
    process.exit(0);
  });
}
process.on("unhandledRejection", (err) => app.log.error({ err }, "unhandled rejection"));

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
app.log.info({ store: ctx.supabase ? "supabase" : "in-memory (dev only)", model: cfg.CLAUDE_MODEL }, "ready");
