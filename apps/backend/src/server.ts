import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { configStatus } from "./config.js";
import type { AppContext } from "./context.js";
import { registerApiRoutes } from "./api/routes.js";
import { registerVoiceRoutes } from "./voice/routes.js";

export async function buildServer(ctx: AppContext) {
  const app = Fastify({
    logger: ctx.cfg.NODE_ENV === "test" ? false : {
      level: ctx.cfg.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-twilio-signature\"]"],
    },
    trustProxy: true, // Railway terminates TLS in front of us
    bodyLimit: 256 * 1024,
  });

  await app.register(cors, {
    origin: [ctx.cfg.DASHBOARD_ORIGIN.replace(/\/$/, "")],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type"],
  });
  await app.register(formbody);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid input", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "Internal error" : (err as Error).message });
  });

  app.get("/health", async () => ({ ok: true, service: "personal-ai-assistant", time: new Date().toISOString() }));
  app.get("/health/ready", async (_req, reply) => {
    const status = configStatus(ctx.cfg);
    let database = "not_configured";
    if (ctx.supabase) {
      try { await ctx.store.getSettings(); database = "ok"; } catch { database = "error"; }
    }
    const ready = status.claude && status.twilio && database !== "error";
    return reply.code(ready ? 200 : 503).send({ ready, database, claude: status.claude, twilio: status.twilio });
  });

  registerVoiceRoutes(app, ctx);
  registerApiRoutes(app, ctx);
  return app;
}
