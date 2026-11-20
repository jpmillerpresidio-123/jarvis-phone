import type { Config } from "../config.js";
import { createHmac } from "node:crypto";
import { SecretBox, safeEqual } from "../lib/crypto.js";
import type { IntegrationRecord, Store, ToolPolicy } from "../store/types.js";
import { GoogleConnector } from "./google/connector.js";
import type { GoogleTokens } from "./google/oauth.js";
import { McpConnector, StoredOAuthProvider, type McpSecret } from "./mcp.js";
import { MemoryConnector } from "./memoryTools.js";
import { ShopifyConnector } from "./shopify.js";
import { SportsConnector } from "./sports.js";
import { BlackbaudConnector } from "./blackbaud.js";
import type { Connector, ToolDescriptor } from "./types.js";

export interface CatalogTool extends ToolDescriptor {
  connectorId: string;
  policy?: ToolPolicy;
}

/**
 * What the Connections page offers. "available" entries can be connected from
 * the dashboard; "unavailable" ones are listed honestly with the reason.
 */
export function integrationOptions(cfg: Config) {
  return [
    { id: "google", kind: "google", name: "Google Workspace", covers: "Gmail, Calendar, Drive, Docs, Sheets, Contacts", auth: "Google OAuth (sign in once)", availability: "available" },
    { id: "shopify", kind: "shopify", name: "Shopify", covers: "Orders, products, store data", auth: "Custom app Admin API token", availability: "available" },
    { id: "mcp", kind: "mcp", name: "Any remote MCP server", covers: "any service with a remote MCP server — tools are discovered automatically", auth: "MCP OAuth or API token", availability: "available" },
    { id: "twilio", kind: "builtin", name: "Twilio", covers: "The phone line itself (incoming calls only)", auth: "Server environment variables", availability: "builtin" },
    { id: "memory", kind: "builtin", name: "Memory", covers: "Saved facts and past calls", auth: "Built in", availability: "builtin" },
    { id: "web", kind: "builtin", name: "Web search", covers: "News, weather, prices and anything current", auth: "Built in (Claude web search, about 1¢ per search)", availability: "builtin" },
    { id: "sports", kind: "builtin", name: "Sports scores", covers: "NBA, NFL, MLB, NHL, WNBA and MLS scores, schedules and records (ESPN)", auth: "Built in, no sign-in", availability: "builtin" },
    cfg.BLACKBAUD_ICAL
      ? { id: "blackbaud", kind: "builtin", name: "Blackbaud assignments", covers: "Homework, tests and due dates from your school feed", auth: "Assignment feed link (server setting)", availability: "builtin" }
      : { id: "blackbaud", kind: "none", name: "Blackbaud assignments", covers: "Homework, tests and due dates", auth: "Assignment feed link", availability: "unavailable", reason: "Not set up yet: add your Blackbaud assignment feed link to the server as BLACKBAUD_ICAL." },
  ];
}

export class Registry {
  private box: SecretBox | null;
  private cache = new Map<string, Connector>();
  readonly memory: MemoryConnector;
  /** Always-on connectors that need no sign-in (memory, sports, and Blackbaud when its feed is set). */
  readonly builtins: Connector[];

  constructor(private cfg: Config, private store: Store, fetcher: typeof fetch = fetch) {
    this.box = cfg.ENCRYPTION_KEY ? new SecretBox(cfg.ENCRYPTION_KEY) : null;
    this.memory = new MemoryConnector(store);
    const settings = () => store.getSettings();
    this.builtins = [
      this.memory,
      new SportsConnector(async () => (await settings()).sportsTeams, fetcher),
      ...(cfg.BLACKBAUD_ICAL ? [new BlackbaudConnector(cfg.BLACKBAUD_ICAL, async () => (await settings()).timezone, fetcher)] : []),
    ];
  }

  seal(obj: unknown): string {
    if (!this.box) throw new Error("ENCRYPTION_KEY is not configured");
    return this.box.seal(JSON.stringify(obj));
  }
  open<T>(sealed: string | null): T | null {
    if (!sealed || !this.box) return null;
    return JSON.parse(this.box.open(sealed)) as T;
  }

  invalidate(id?: string) {
    if (id) {
      const c = this.cache.get(id);
      if (c instanceof McpConnector) void c.close();
      this.cache.delete(id);
    } else {
      for (const k of [...this.cache.keys()]) this.invalidate(k);
    }
  }

  /** OAuth `state`: integration id + expiry, HMAC-signed so callbacks can't be forged. */
  signState(id: string, ttlSec = 900): string {
    const body = `${Buffer.from(id).toString("base64url")}.${Math.floor(Date.now() / 1000) + ttlSec}`;
    return `${body}.${this.stateMac(body)}`;
  }
  verifyState(state: string | undefined): string | null {
    if (!state) return null;
    const [idB64, exp, mac] = state.split(".");
    if (!idB64 || !exp || !mac || Number(exp) < Date.now() / 1000) return null;
    if (!safeEqual(this.stateMac(`${idB64}.${exp}`), mac)) return null;
    return Buffer.from(idB64, "base64url").toString("utf8");
  }
  private stateMac(body: string) {
    if (!this.cfg.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not configured");
    return createHmac("sha256", `oauth-state:${this.cfg.ENCRYPTION_KEY}`).update(body).digest("base64url");
  }

  mcpRedirectUri() { return `${this.cfg.PUBLIC_BASE_URL}/oauth/mcp/callback`; }

  /** Builds a connector from its stored record. Throws if it can't be built. */
  async build(rec: IntegrationRecord): Promise<Connector> {
    const cached = this.cache.get(rec.id);
    if (cached) return cached;
    let c: Connector;
    if (rec.kind === "google") {
      const tokens = this.open<GoogleTokens>(rec.secret);
      if (!tokens?.refresh_token) throw new Error("Google is not authorized yet");
      if (!this.cfg.GOOGLE_CLIENT_ID || !this.cfg.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth client is not configured on the server");
      c = new GoogleConnector(this.cfg.GOOGLE_CLIENT_ID, this.cfg.GOOGLE_CLIENT_SECRET, tokens, async (t) => {
        const latest = await this.store.getIntegration(rec.id);
        if (latest) await this.store.upsertIntegration({ ...latest, secret: this.seal(t) });
      });
    } else if (rec.kind === "shopify") {
      const s = this.open<{ token: string }>(rec.secret);
      if (!s?.token) throw new Error("Shopify token missing");
      c = new ShopifyConnector(String(rec.config.shopDomain ?? ""), s.token);
    } else {
      const secret = this.open<McpSecret>(rec.secret) ?? { mode: "none" };
      const persist = async (s: McpSecret) => {
        const latest = await this.store.getIntegration(rec.id);
        if (latest) await this.store.upsertIntegration({ ...latest, secret: this.seal(s) });
      };
      const provider = secret.mode === "oauth" ? new StoredOAuthProvider(secret, this.mcpRedirectUri(), this.signState(rec.id), persist) : null;
      c = new McpConnector(rec.id, rec.displayName, String(rec.config.url ?? ""), secret, provider);
    }
    this.cache.set(rec.id, c);
    return c;
  }

  /**
   * Every tool the assistant may use on this call: built-in memory plus each
   * integration that is enabled AND passed its last live test. Integrations that
   * fail to load are skipped and reported, never faked.
   */
  async catalog(): Promise<{ tools: CatalogTool[]; problems: string[] }> {
    const tools: CatalogTool[] = [];
    for (const b of this.builtins) tools.push(...(await b.listTools()).map((t) => ({ ...t, connectorId: b.id })));
    const problems: string[] = [];
    const recs = (await this.store.listIntegrations()).filter((r) => r.enabled && r.status === "connected");
    await Promise.all(recs.map(async (rec) => {
      try {
        const c = await this.build(rec);
        const list = await withTimeout(c.listTools(), 8000, `${rec.displayName} tool discovery`);
        for (const t of list) tools.push({ ...t, connectorId: rec.id, policy: rec.toolPolicies[t.name] });
      } catch (e) {
        problems.push(`${rec.displayName}: ${(e as Error).message}`);
        this.invalidate(rec.id);
      }
    }));
    const seen = new Set<string>();
    return { tools: tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true))), problems };
  }

  /** Persists a new MCP secret and returns a provider for running the OAuth flow. */
  mcpProvider(rec: IntegrationRecord, secret: McpSecret) {
    const persist = async (s: McpSecret) => {
      const latest = (await this.store.getIntegration(rec.id)) ?? rec;
      await this.store.upsertIntegration({ ...latest, secret: this.seal(s) });
    };
    return new StoredOAuthProvider(secret, this.mcpRedirectUri(), this.signState(rec.id), persist);
  }

  async connectorFor(id: string): Promise<Connector> {
    const builtin = this.builtins.find((b) => b.id === id);
    if (builtin) return builtin;
    const rec = await this.store.getIntegration(id);
    if (!rec) throw new Error(`Integration ${id} not found`);
    return this.build(rec);
  }

  /** Live test. Only a pass sets status "connected". */
  async test(id: string) {
    const rec = await this.store.getIntegration(id);
    if (!rec) throw new Error(`Integration ${id} not found`);
    this.invalidate(id);
    const now = new Date().toISOString();
    try {
      const c = await this.build(rec);
      const r = await withTimeout(c.test(), 20000, "Connection test");
      const latest = (await this.store.getIntegration(id)) ?? rec;
      await this.store.upsertIntegration({ ...latest, status: r.ok ? "connected" : "error", lastTestedAt: now, lastError: r.ok ? null : r.detail, toolCount: r.toolCount });
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      const latest = (await this.store.getIntegration(id)) ?? rec;
      const needsAuth = /unauthori[sz]ed|401|invalid_grant|not authorized/i.test(msg);
      await this.store.upsertIntegration({ ...latest, status: needsAuth ? "needs_auth" : "error", lastTestedAt: now, lastError: msg });
      this.invalidate(id);
      return { ok: false, detail: msg, toolCount: 0 };
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
