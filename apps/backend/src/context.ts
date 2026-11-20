import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { anthropicStreamFn, type StreamFn } from "./agent/engine.js";
import { Registry } from "./integrations/registry.js";
import { InMemoryStore } from "./store/memoryStore.js";
import { SupabaseStore } from "./store/supabaseStore.js";
import type { Store } from "./store/types.js";

export interface AppContext {
  cfg: Config;
  store: Store;
  registry: Registry;
  anthropic: Anthropic | null;
  streamFn: StreamFn;
  supabase: SupabaseStore | null;
}

export function buildContext(cfg: Config, overrides: Partial<AppContext> = {}): AppContext {
  const supabase = cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_ROLE_KEY ? new SupabaseStore(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY) : null;
  const store: Store = overrides.store ?? supabase ?? new InMemoryStore();
  const anthropic = overrides.anthropic !== undefined ? overrides.anthropic : cfg.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 }) : null;
  const streamFn: StreamFn = overrides.streamFn ?? (anthropic ? anthropicStreamFn(anthropic) : () => { throw new Error("ANTHROPIC_API_KEY is not configured"); });
  return { cfg, store, registry: overrides.registry ?? new Registry(cfg, store), anthropic, streamFn, supabase: overrides.supabase ?? supabase };
}
