import type { BetaMessage, BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { loadConfig, type Config } from "../src/config.js";
import type { StreamFn, StreamLike } from "../src/agent/engine.js";
import { Registry, type CatalogTool } from "../src/integrations/registry.js";
import type { Connector, ToolDescriptor, ToolResult } from "../src/integrations/types.js";
import { InMemoryStore } from "../src/store/memoryStore.js";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    ANTHROPIC_API_KEY: "test-key",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-secret",
    TWILIO_PHONE_NUMBER: "+15550000000",
    ALLOWED_CALLERS: "+15551112222",
    ENCRYPTION_KEY: TEST_KEY,
    PUBLIC_BASE_URL: "https://pa.example.com",
    ...over,
  });
}

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };

let idCounter = 0;
export function message(blocks: Block[]): BetaMessage {
  const content = blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text, citations: null } : { type: "tool_use", id: `toolu_${++idCounter}`, name: b.name, input: b.input }));
  return {
    id: `msg_${idCounter}`, type: "message", role: "assistant", model: "claude-opus-5-5", content,
    stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

/** A StreamFn that replays scripted assistant messages and records each request. */
export type ScriptItem = BetaMessage | ((lastRequest: Record<string, unknown>) => BetaMessage);
export function scriptedStream(script: ScriptItem[]) {
  const requests: unknown[] = [];
  const fn: StreamFn = (params, opts) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const item = script.shift();
    if (!item) throw new Error("script exhausted");
    const msg = typeof item === "function" ? item(params as unknown as Record<string, unknown>) : item;
    const events: BetaRawMessageStreamEvent[] = [];
    for (const b of msg.content) {
      if (b.type === "text") for (const word of b.text.split(/(?<= )/)) events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } } as BetaRawMessageStreamEvent);
    }
    const s: StreamLike = {
      async *[Symbol.asyncIterator]() {
        for (const e of events) {
          if (opts.signal?.aborted) { const err = new Error("aborted"); err.name = "AbortError"; throw err; }
          await new Promise((r) => setTimeout(r, 1));
          yield e;
        }
      },
      finalMessage: async () => msg,
    };
    return s;
  };
  return { fn, requests };
}

export class FakeConnector implements Connector {
  id = "fake";
  displayName = "Fake Mail";
  calls: { name: string; input: Record<string, unknown> }[] = [];
  constructor(private tools: ToolDescriptor[]) {}
  async listTools() { return this.tools; }
  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, input });
    return { ok: true, content: `done ${name}`, verification: `id:${this.calls.length}` };
  }
  async test() { return { ok: true, detail: "ok", toolCount: this.tools.length }; }
}

export class FakeRegistry extends Registry {
  constructor(cfg: Config, store: InMemoryStore, public fake: FakeConnector) { super(cfg, store); }
  override async catalog() {
    const mem = (await this.memory.listTools()).map((t) => ({ ...t, connectorId: "memory" }));
    const tools: CatalogTool[] = [...mem, ...(await this.fake.listTools()).map((t) => ({ ...t, connectorId: "fake" }))];
    return { tools, problems: [] };
  }
  override async connectorFor(id: string) { return id === "memory" ? this.memory : this.fake; }
}

export const fakeTools: ToolDescriptor[] = [
  { name: "mail__search", description: "search mail", inputSchema: { type: "object", properties: { q: { type: "string" } } }, risk: "read", core: true },
  { name: "mail__send", description: "send mail", inputSchema: { type: "object", properties: { to: { type: "string" } } }, risk: "consequential", core: true, describe: (i) => `send an email to ${String(i.to)}` },
  { name: "phone__make_call", description: "call someone", inputSchema: { type: "object", properties: {} }, core: true },
];
