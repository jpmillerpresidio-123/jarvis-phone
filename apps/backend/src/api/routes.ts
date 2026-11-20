import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { configStatus } from "../config.js";
import { CallSession } from "../agent/engine.js";
import { classify } from "../agent/gate.js";
import { TWILIO_NUMBER_MONTHLY } from "../agent/pricing.js";
import type { AppContext } from "../context.js";
import { exchangeCode, googleAccountEmail, googleAuthUrl, GOOGLE_SCOPES } from "../integrations/google/oauth.js";
import { mcpAuthorize, type McpSecret } from "../integrations/mcp.js";
import { integrationOptions } from "../integrations/registry.js";
import { DEFAULT_SETTINGS, type IntegrationRecord } from "../store/types.js";

declare module "fastify" {
  interface FastifyRequest { ownerEmail?: string }
}

const SettingsPatch = z.object({
  assistantName: z.string().min(1).max(40),
  personality: z.string().max(600),
  responseStyle: z.enum(["brief", "balanced", "detailed"]),
  greeting: z.string().max(200),
  ttsProvider: z.enum(["ElevenLabs", "Google", "Amazon"]),
  voice: z.string().max(120).nullable(),
  language: z.string().max(10),
  memoryEnabled: z.boolean(),
  autoSaveMemories: z.boolean(),
  confirmWrites: z.boolean(),
  timezone: z.string().max(60),
  monthlyBudgetUsd: z.number().min(0).max(10000).nullable(),
  ownerName: z.string().max(40),
  sportsTeams: z.string().max(300),
  webSearch: z.boolean(),
}).partial().strict();

const MemoryInput = z.object({
  content: z.string().min(1).max(2000),
  category: z.enum(["preference", "instruction", "project", "contact", "decision", "task", "other"]).default("other"),
  pinned: z.boolean().optional(),
}).strict();

const McpInput = z.object({
  name: z.string().min(2).max(40),
  url: z.string().url().refine((u) => u.startsWith("https://"), "MCP server URL must use https"),
  authMode: z.enum(["oauth", "token", "none"]),
  token: z.string().max(4000).optional(),
}).strict();

const ShopifyInput = z.object({
  shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i, "Use your-store.myshopify.com"),
  token: z.string().min(10).max(200),
}).strict();

const PolicyInput = z.object({
  enabled: z.boolean().optional(),
  toolPolicies: z.record(z.string().max(80), z.enum(["auto", "confirm", "block", "default"])).optional(),
}).strict();

const publicIntegration = (r: IntegrationRecord) => {
  const { secret: _secret, ...rest } = r;
  return { ...rest, hasCredentials: Boolean(_secret) };
};

export function registerApiRoutes(app: FastifyInstance, ctx: AppContext) {
  const { cfg, store, registry } = ctx;
  const dashboard = cfg.DASHBOARD_ORIGIN.replace(/\/$/, "");
  const testSessions = new Map<string, { session: CallSession; at: number }>();

  async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return reply.code(401).send({ error: "Sign in required" });
    if (!ctx.supabase || !cfg.OWNER_EMAIL) {
      if (cfg.NODE_ENV !== "production" && token === "dev-local") { req.ownerEmail = "dev@localhost"; return; }
      return reply.code(503).send({ error: "Authentication is not configured on the server" });
    }
    const { data, error } = await ctx.supabase.client.auth.getUser(token);
    const email = data.user?.email?.toLowerCase();
    if (error || !email || email !== cfg.OWNER_EMAIL.toLowerCase()) {
      await store.audit({ actor: "system", action: "api_denied", detail: { email: email ?? null, path: req.url }, at: new Date().toISOString() }).catch(() => undefined);
      return reply.code(403).send({ error: "This dashboard belongs to someone else" });
    }
    req.ownerEmail = email;
  }

  app.register(async (api) => {
    api.addHook("preHandler", requireOwner);

    api.get("/api/status", async () => {
      const [integrations, mtd, settings, calls] = await Promise.all([store.listIntegrations(), store.monthToDateCostUsd(), store.getSettings(), store.recentCalls(1)]);
      const budget = settings.monthlyBudgetUsd ?? cfg.MONTHLY_BUDGET_USD;
      return {
        config: configStatus(cfg),
        phoneNumber: cfg.TWILIO_PHONE_NUMBER ?? null,
        integrations: integrations.map(publicIntegration),
        monthToDateUsd: mtd,
        budgetUsd: budget,
        budgetWarning: mtd >= budget * 0.8,
        lastCallAt: calls[0]?.startedAt ?? null,
        ready: Boolean(cfg.ANTHROPIC_API_KEY && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_PHONE_NUMBER && configStatus(cfg).allowedCallers > 0),
      };
    });

    // Settings
    api.get("/api/settings", async () => store.getSettings());
    api.put("/api/settings", async (req) => {
      const patch = SettingsPatch.parse(req.body);
      const next = await store.updateSettings(patch);
      await store.audit({ actor: "owner", action: "settings_updated", detail: { fields: Object.keys(patch) }, at: new Date().toISOString() });
      return next;
    });
    api.get("/api/settings/defaults", async () => DEFAULT_SETTINGS);

    // Memory
    api.get("/api/memories", async (req) => {
      const q = (req.query as { q?: string }).q;
      return q ? store.searchMemories(q, 100) : store.listMemories({ limit: 500 });
    });
    api.post("/api/memories", async (req) => {
      const m = MemoryInput.parse(req.body);
      return store.addMemory({ ...m, source: "dashboard" });
    });
    api.patch("/api/memories/:id", async (req, reply) => {
      const m = MemoryInput.partial().parse(req.body);
      const r = await store.updateMemory((req.params as { id: string }).id, m);
      return r ?? reply.code(404).send({ error: "Not found" });
    });
    api.delete("/api/memories/:id", async (req) => {
      const ok = await store.deleteMemory((req.params as { id: string }).id);
      await store.audit({ actor: "owner", action: "memory_deleted", detail: {}, at: new Date().toISOString() });
      return { ok };
    });

    // Calls, tasks, usage, audit
    api.get("/api/calls", async () => store.recentCalls(200));
    api.get("/api/calls/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const call = await store.getCall(id);
      if (!call) return reply.code(404).send({ error: "Not found" });
      const [transcript, tasks] = await Promise.all([store.getTranscript(id), store.listTasks({ callId: id })]);
      return { call, transcript, tasks };
    });
    api.get("/api/tasks", async (req) => {
      const status = (req.query as { status?: string }).status as never;
      return store.listTasks({ status, limit: 300 });
    });
    api.get("/api/usage", async () => {
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const events = await store.usageSince(start.toISOString());
      const byDay = new Map<string, { day: string; claudeUsd: number; twilioUsd: number }>();
      let inputTokens = 0, outputTokens = 0, cacheRead = 0, minutes = 0, claudeUsd = 0, twilioUsd = 0;
      for (const e of events) {
        const day = e.at.slice(0, 10);
        const d = byDay.get(day) ?? { day, claudeUsd: 0, twilioUsd: 0 };
        if (e.kind === "claude") { d.claudeUsd += e.costUsd; claudeUsd += e.costUsd; inputTokens += e.inputTokens ?? 0; outputTokens += e.outputTokens ?? 0; cacheRead += e.cacheReadTokens ?? 0; }
        else { d.twilioUsd += e.costUsd; twilioUsd += e.costUsd; minutes += e.minutes ?? 0; }
        byDay.set(day, d);
      }
      const now = new Date();
      const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
      const dayOfMonth = Math.max(1, now.getUTCDate());
      const variable = claudeUsd + twilioUsd;
      const projectedVariable = (variable / dayOfMonth) * daysInMonth;
      const fixed = cfg.HOSTING_MONTHLY_USD + TWILIO_NUMBER_MONTHLY;
      const settings = await store.getSettings();
      return {
        monthStart: start.toISOString(),
        tokens: { input: inputTokens, output: outputTokens, cacheRead },
        twilioMinutes: minutes,
        costs: { claudeUsd, twilioUsd, hostingUsd: cfg.HOSTING_MONTHLY_USD, numberUsd: TWILIO_NUMBER_MONTHLY },
        monthToDateUsd: variable,
        projectedMonthUsd: projectedVariable + fixed,
        budgetUsd: settings.monthlyBudgetUsd ?? cfg.MONTHLY_BUDGET_USD,
        daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
        model: cfg.CLAUDE_MODEL,
      };
    });
    api.get("/api/audit", async () => store.listAudit(200));

    // Connections
    api.get("/api/connections", async () => {
      const recs = await store.listIntegrations();
      return { options: integrationOptions(cfg), integrations: recs.map(publicIntegration), googleConfigured: Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET), googleScopes: GOOGLE_SCOPES };
    });
    api.get("/api/connections/:id/tools", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const rec = id === "memory" ? null : await store.getIntegration(id);
      if (id !== "memory" && !rec) return reply.code(404).send({ error: "Not found" });
      try {
        const c = await registry.connectorFor(id);
        const settings = await store.getSettings();
        const tools = await c.listTools();
        return tools.map((t) => ({
          name: t.name, description: t.description,
          defaultRisk: classify(t, {}, undefined, settings.confirmWrites),
          policy: rec?.toolPolicies[t.name] ?? null,
        }));
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });
    api.post("/api/connections/:id/test", async (req) => {
      const id = (req.params as { id: string }).id;
      const r = await registry.test(id);
      await store.audit({ actor: "owner", action: "integration_tested", detail: { id, ok: r.ok }, at: new Date().toISOString() });
      return r;
    });
    api.patch("/api/connections/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const body = PolicyInput.parse(req.body);
      const rec = await store.getIntegration(id);
      if (!rec) return reply.code(404).send({ error: "Not found" });
      const policies = { ...rec.toolPolicies };
      for (const [name, p] of Object.entries(body.toolPolicies ?? {})) {
        if (p === "default") delete policies[name]; else policies[name] = p;
      }
      const next = { ...rec, enabled: body.enabled ?? rec.enabled, toolPolicies: policies };
      await store.upsertIntegration(next);
      registry.invalidate(id);
      await store.audit({ actor: "owner", action: "integration_updated", detail: { id, ...body }, at: new Date().toISOString() });
      return publicIntegration(next);
    });
    api.delete("/api/connections/:id", async (req) => {
      const id = (req.params as { id: string }).id;
      registry.invalidate(id);
      await store.deleteIntegration(id);
      await store.audit({ actor: "owner", action: "integration_removed", detail: { id }, at: new Date().toISOString() });
      return { ok: true };
    });

    api.post("/api/connections/google/start", async (_req, reply) => {
      if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) return reply.code(400).send({ error: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server first (see docs/SETUP.md)." });
      return { url: googleAuthUrl(cfg.GOOGLE_CLIENT_ID, `${cfg.PUBLIC_BASE_URL}/oauth/google/callback`, registry.signState("google")) };
    });

    api.post("/api/connections/shopify", async (req) => {
      const body = ShopifyInput.parse(req.body);
      await store.upsertIntegration({
        id: "shopify", kind: "shopify", displayName: "Shopify", enabled: true, secret: registry.seal({ token: body.token }),
        config: { shopDomain: body.shopDomain.toLowerCase() }, toolPolicies: {}, status: "untested", lastTestedAt: null, lastError: null, toolCount: 0,
      });
      registry.invalidate("shopify");
      return registry.test("shopify");
    });

    api.post("/api/connections/mcp", async (req, reply) => {
      const body = McpInput.parse(req.body);
      const id = `mcp:${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const secret: McpSecret = body.authMode === "token" ? { mode: "token", token: body.token } : { mode: body.authMode };
      const rec: IntegrationRecord = {
        id, kind: "mcp", displayName: body.name, enabled: true, secret: registry.seal(secret), config: { url: body.url },
        toolPolicies: {}, status: body.authMode === "oauth" ? "needs_auth" : "untested", lastTestedAt: null, lastError: null, toolCount: 0,
      };
      await store.upsertIntegration(rec);
      registry.invalidate(id);
      await store.audit({ actor: "owner", action: "integration_added", detail: { id, url: body.url, authMode: body.authMode }, at: new Date().toISOString() });
      if (body.authMode === "oauth") {
        try {
          const url = await mcpAuthorize(body.url, registry.mcpProvider(rec, secret));
          if (url) return { id, authorizeUrl: url.toString() };
        } catch (e) {
          await store.upsertIntegration({ ...((await store.getIntegration(id)) ?? rec), status: "error", lastError: (e as Error).message });
          return reply.code(502).send({ id, error: `This server's sign-in couldn't start: ${(e as Error).message}` });
        }
      }
      return { id, test: await registry.test(id) };
    });

    // Text chat with the same brain the phone uses — for trying things from the dashboard.
    api.post("/api/assistant/message", async (req, reply) => {
      const { text, sessionId } = z.object({ text: z.string().min(1).max(2000), sessionId: z.string().max(64).optional() }).parse(req.body);
      if (!cfg.ANTHROPIC_API_KEY && !ctx.anthropic) return reply.code(400).send({ error: "ANTHROPIC_API_KEY is not configured" });
      for (const [k, v] of testSessions) if (Date.now() - v.at > 30 * 60_000) testSessions.delete(k);
      let sid = sessionId && testSessions.has(sessionId) ? sessionId : undefined;
      if (!sid) {
        sid = randomUUID();
        const s = new CallSession(cfg, store, registry, ctx.streamFn, null, `dashboard-${sid}`);
        await s.init();
        s.pinVerified = true; // owner is already signed in
        testSessions.set(sid, { session: s, at: Date.now() });
      }
      const entry = testSessions.get(sid)!;
      entry.at = Date.now();
      let out = "";
      await entry.session.respond(text, { onText: (t) => { out += t; }, onTurnEnd: () => undefined });
      return { sessionId: sid, reply: out.trim() };
    });
  });

  // OAuth callbacks (browser redirects; protected by signed state instead of a bearer token).
  app.get("/oauth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.redirect(`${dashboard}/connections?error=${encodeURIComponent(q.error)}`);
    if (registry.verifyState(q.state) !== "google" || !q.code) return reply.code(400).send("Invalid or expired sign-in link. Start again from the dashboard.");
    try {
      const t = await exchangeCode(cfg.GOOGLE_CLIENT_ID!, cfg.GOOGLE_CLIENT_SECRET!, `${cfg.PUBLIC_BASE_URL}/oauth/google/callback`, q.code);
      const existing = await store.getIntegration("google");
      const prior = existing ? registry.open<{ refresh_token: string }>(existing.secret) : null;
      const refresh = t.refresh_token ?? prior?.refresh_token;
      if (!refresh) throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and try again.");
      const email = await googleAccountEmail(t.access_token);
      await store.upsertIntegration({
        id: "google", kind: "google", displayName: "Google Workspace", enabled: true,
        secret: registry.seal({ refresh_token: refresh, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, scope: t.scope }),
        config: { account: email, scopes: t.scope?.split(" ") ?? [] }, toolPolicies: existing?.toolPolicies ?? {},
        status: "untested", lastTestedAt: null, lastError: null, toolCount: 0,
      });
      registry.invalidate("google");
      const r = await registry.test("google");
      await store.audit({ actor: "owner", action: "integration_authorized", detail: { id: "google", account: email, ok: r.ok }, at: new Date().toISOString() });
      return reply.redirect(`${dashboard}/connections?${r.ok ? "connected=google" : `error=${encodeURIComponent(r.detail)}`}`);
    } catch (e) {
      return reply.redirect(`${dashboard}/connections?error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  app.get("/oauth/mcp/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const id = registry.verifyState(q.state);
    if (q.error) return reply.redirect(`${dashboard}/connections?error=${encodeURIComponent(q.error)}`);
    if (!id || !q.code) return reply.code(400).send("Invalid or expired sign-in link. Start again from the dashboard.");
    const rec = await store.getIntegration(id);
    if (!rec || rec.kind !== "mcp") return reply.code(404).send("Unknown integration");
    try {
      const secret = registry.open<McpSecret>(rec.secret) ?? { mode: "oauth" };
      const again = await mcpAuthorize(String(rec.config.url), registry.mcpProvider(rec, secret), q.code);
      if (again) throw new Error("The server asked to sign in again");
      registry.invalidate(id);
      const r = await registry.test(id);
      return reply.redirect(`${dashboard}/connections?${r.ok ? `connected=${encodeURIComponent(id)}` : `error=${encodeURIComponent(r.detail)}`}`);
    } catch (e) {
      return reply.redirect(`${dashboard}/connections?error=${encodeURIComponent((e as Error).message)}`);
    }
  });
}
