import { createHash, randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Config } from "../config.js";
import type { CatalogTool, Registry } from "../integrations/registry.js";
import { withTimeout } from "../integrations/registry.js";
import type { AssistantSettings, Risk, Store } from "../store/types.js";
import { classify } from "./gate.js";
import { claudeCostUsd } from "./pricing.js";
import { dynamicContext, staticSystemPrompt } from "./prompt.js";

export interface StreamLike extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}
/** Thin seam over client.beta.messages.stream so tests can script responses. */
export type StreamFn = (params: BetaMessageStreamParams, opts: { signal?: AbortSignal }) => StreamLike;

export function anthropicStreamFn(client: Anthropic): StreamFn {
  return (params, opts) => client.beta.messages.stream(params, { signal: opts.signal }) as unknown as StreamLike;
}

export interface Sink {
  onText(token: string): void;
  onTurnEnd(): void;
}

interface Pending {
  id: string;
  taskId: string;
  tool: CatalogTool;
  input: Record<string, unknown>;
  summary: string;
  createdAtTurn: number;
  expiresAt: number;
  idempotencyKey: string;
}

const AFFIRM = /\b(yes|yeah|yep|yup|sure|go ahead|do it|confirm(ed)?|send it|please do|ok(ay)?|correct|that's right|sounds good|absolutely|definitely)\b/i;
const NEGATE = /\b(no|nope|don't|do not|wait|stop|cancel|hold on|never mind|not yet)\b/i;
const MAX_STEPS_PER_TURN = 8;
const DEFER_THRESHOLD = 25;

const CONTROL_TOOLS = [
  {
    name: "confirm_action",
    description: "Execute an action that returned CONFIRMATION_REQUIRED, only after the caller clearly said yes in their latest reply.",
    input_schema: { type: "object" as const, properties: { action_id: { type: "string" } }, required: ["action_id"], additionalProperties: false },
  },
  {
    name: "cancel_action",
    description: "Cancel a pending action the caller declined or changed their mind about.",
    input_schema: { type: "object" as const, properties: { action_id: { type: "string" } }, required: ["action_id"], additionalProperties: false },
  },
];

const LOOKUP_BLOCKS = new Set(["tool_use", "server_tool_use"]);
const CONTROL_NAMES = new Set(CONTROL_TOOLS.map((t) => t.name));
/** Spoken right away when a turn starts with a lookup, so the caller isn't left in silence. */
const FILLER = "One sec. ";

export class CallSession {
  readonly messages: BetaMessageParam[] = [];
  private userTurn = 0;
  private lastUserText = "";
  private pending = new Map<string, Pending>();
  /** idempotency key -> result, so a repeated consequential call in this call never runs twice */
  private completed = new Map<string, string>();
  private tools: CatalogTool[] = [];
  private toolByName = new Map<string, CatalogTool>();
  private system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] = [];
  private settings!: AssistantSettings;
  pinVerified = false;
  awaitingPinFor: string | null = null;
  errors: string[] = [];

  constructor(
    private cfg: Config,
    private store: Store,
    private registry: Registry,
    private stream: StreamFn,
    readonly callId: string | null,
    readonly callSid: string,
  ) {}

  get pinRequired() { return Boolean(this.cfg.VOICE_PIN); }

  async init() {
    this.settings = await this.store.getSettings();
    const [{ tools, problems }, pinned, recent, calls] = await Promise.all([
      this.registry.catalog(),
      this.settings.memoryEnabled ? this.store.listMemories({ pinnedOnly: true, limit: 30 }) : Promise.resolve([]),
      this.settings.memoryEnabled ? this.store.listMemories({ limit: 25 }) : Promise.resolve([]),
      this.store.recentCalls(4),
    ]);
    this.tools = tools;
    this.toolByName = new Map(tools.map((t) => [t.name, t]));
    const seen = new Set<string>();
    const memories = [...pinned, ...recent].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).slice(0, 40);
    const connectedNames = [...new Set(tools.map((t) => t.connectorId))].filter((id) => id !== "memory");
    this.system = [
      { type: "text", text: staticSystemPrompt(this.settings), cache_control: { type: "ephemeral" } },
      {
        type: "text",
        text: dynamicContext({
          settings: this.settings,
          now: new Date(),
          callerVerified: true,
          pinVerified: this.pinVerified,
          pinRequired: this.pinRequired,
          memories,
          recentSummaries: calls.filter((c) => c.summary && c.callSid !== this.callSid).map((c) => `${c.startedAt.slice(0, 10)}: ${c.summary}`),
          integrationProblems: problems,
          connectedNames,
        }),
      },
    ];
    if (problems.length) this.errors.push(...problems);
    return { toolCount: tools.length, problems };
  }

  private apiTools(): BetaToolUnion[] {
    const defer = this.tools.length > DEFER_THRESHOLD;
    const list: BetaToolUnion[] = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: "object", ...(t.inputSchema as object) } as { type: "object" },
      ...(defer && !t.core ? { defer_loading: true } : {}),
    }));
    list.push(...CONTROL_TOOLS);
    // Claude's server-side web search for anything current. Fixed for the whole call so
    // the tools list (and the prompt cache) never changes mid-conversation. The basic
    // version answers in about half the time of the dynamic-filtering one, which matters
    // more on a phone call than the extra precision.
    if (this.settings?.webSearch !== false) {
      list.push({
        type: "web_search_20250305", name: "web_search", max_uses: 3,
        user_location: { type: "approximate", country: "US", timezone: this.settings?.timezone ?? "America/Los_Angeles" },
      });
    }
    if (defer) list.push({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
    return list;
  }

  /** Adds caller text, merging into a trailing user message so roles stay alternating. */
  private addUser(content: BetaContentBlockParam[]) {
    const last = this.messages.at(-1);
    if (last?.role === "user") {
      const existing = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content }];
      last.content = [...existing, ...content];
    } else {
      this.messages.push({ role: "user", content });
    }
  }

  async respond(text: string, sink: Sink, signal?: AbortSignal, opts: { interruptedAfter?: string } = {}) {
    this.userTurn++;
    this.lastUserText = text;
    const prefix = opts.interruptedAfter ? `(The caller interrupted you after you said: "${opts.interruptedAfter}")\n` : "";
    this.addUser([{ type: "text", text: prefix + text }]);
    await this.store.appendTranscript({ callId: this.callId ?? "", role: "caller", text, at: new Date().toISOString() }).catch(() => undefined);
    await this.runLoop(sink, signal);
  }

  /** Called after a correct keypad PIN so the model continues the pending confirmation. */
  async resumeAfterPin(sink: Sink, signal?: AbortSignal) {
    this.userTurn++;
    this.lastUserText = "yes";
    this.addUser([{ type: "text", text: "(System: the caller entered the correct PIN on the keypad. Continue with the action they confirmed.)" }]);
    await this.runLoop(sink, signal);
  }

  private async runLoop(sink: Sink, signal?: AbortSignal) {
    let spoken = "";
    try {
      for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
        if (signal?.aborted) return;
        const params: BetaMessageStreamParams = {
          model: this.cfg.CLAUDE_MODEL,
          max_tokens: 8000,
          system: this.system,
          messages: this.messages,
          tools: this.apiTools(),
          output_config: { effort: this.cfg.CLAUDE_EFFORT },
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        };
        const s = this.stream(params, { signal });
        for await (const ev of s) {
          // A lookup is starting and nothing has been said yet this turn: fill the silence.
          if (ev.type === "content_block_start" && !spoken.trim() && LOOKUP_BLOCKS.has(ev.content_block.type)
              && !CONTROL_NAMES.has((ev.content_block as { name?: string }).name ?? "")) {
            spoken += FILLER;
            sink.onText(FILLER);
          }
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            spoken += ev.delta.text;
            sink.onText(ev.delta.text);
          }
        }
        const msg = await s.finalMessage();
        this.messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        void this.recordUsage(msg);

        if (msg.stop_reason === "refusal") {
          sink.onText(" Sorry, I can't help with that one.");
          break;
        }
        if (msg.stop_reason === "pause_turn") continue;
        const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
        const truncated = msg.stop_reason === "max_tokens" && uses.length > 0;
        if ((msg.stop_reason !== "tool_use" && !truncated) || uses.length === 0) break;

        const results = await Promise.all(uses.map((u) =>
          truncated ? errorResult(u.id, "Tool input was cut off; try again with a shorter input.") : this.runTool(u)));
        this.messages.push({ role: "user", content: results });
      }
    } catch (e) {
      if (signal?.aborted || (e as Error).name === "AbortError" || /abort/i.test((e as Error).message)) return; // interrupted; partial turn discarded
      this.errors.push((e as Error).message);
      sink.onText(" Sorry, I ran into a problem on my end. Could you say that again?");
    } finally {
      if (spoken.trim()) {
        await this.store.appendTranscript({ callId: this.callId ?? "", role: "assistant", text: spoken.trim(), at: new Date().toISOString() }).catch(() => undefined);
      }
      sink.onTurnEnd();
    }
  }

  private async recordUsage(msg: BetaMessage) {
    const u = msg.usage;
    await this.store.recordUsage({
      kind: "claude", callId: this.callId, model: msg.model,
      inputTokens: u.input_tokens, outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: claudeCostUsd(msg.model, u), at: new Date().toISOString(),
    }).catch(() => undefined);
  }

  private async runTool(u: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
    const input = (u.input && typeof u.input === "object" ? u.input : {}) as Record<string, unknown>;
    if (u.name === "confirm_action") return this.confirm(u.id, String(input.action_id ?? ""));
    if (u.name === "cancel_action") return this.cancel(u.id, String(input.action_id ?? ""));

    const tool = this.toolByName.get(u.name);
    if (!tool) return errorResult(u.id, `No connected tool named ${u.name}.`);
    const risk: Risk = classify(tool, input, tool.policy, this.settings.confirmWrites);
    const summary = tool.describe?.(input) ?? `${u.name.replace(/__/g, ": ").replace(/_/g, " ")}`;
    const key = this.idempotencyKey(tool.name, input);

    if (risk === "blocked") {
      await this.logTask(tool, input, summary, "blocked", risk, key, null, "Blocked by policy");
      return errorResult(u.id, "BLOCKED: this action is not allowed (no phone calls, purchases, payments, or tools the owner blocked). Tell the caller you can't do it.");
    }
    if (risk === "consequential") {
      const prior = this.completed.get(key);
      if (prior) return okResult(u.id, `Already done earlier in this call: ${prior}. Don't repeat it.`);
      const task = await this.logTask(tool, input, summary, "pending_confirmation", risk, `${key}:${randomUUID().slice(0, 8)}`, null, null);
      const id = randomUUID().slice(0, 8);
      this.pending.set(id, { id, taskId: task?.id ?? "", tool, input, summary, createdAtTurn: this.userTurn, expiresAt: Date.now() + 5 * 60_000, idempotencyKey: key });
      return okResult(u.id, `CONFIRMATION_REQUIRED action_id=${id}. Not executed yet. Ask the caller: "I'm about to ${summary}. Should I go ahead?"`);
    }
    return this.execute(u.id, tool, input, summary, risk, key);
  }

  private async execute(toolUseId: string, tool: CatalogTool, input: Record<string, unknown>, summary: string, risk: Risk, key: string, existingTaskId?: string) {
    const isMemoryRead = tool.name === "memory__recall";
    const task = existingTaskId ? { id: existingTaskId } : isMemoryRead ? null : await this.logTask(tool, input, summary, "running", risk, `${key}:${randomUUID().slice(0, 8)}`, null, null);
    try {
      const connector = await this.registry.connectorFor(tool.connectorId);
      const r = await withTimeout(connector.callTool(tool.name, input), 30_000, tool.name);
      if (r.ok && risk === "consequential") this.completed.set(key, summary);
      if (task?.id) await this.store.updateTask(task.id, { status: r.ok ? "completed" : "failed", result: r.verification ?? r.content.slice(0, 500), error: r.ok ? null : r.content.slice(0, 500) }).catch(() => undefined);
      await this.store.appendTranscript({ callId: this.callId ?? "", role: "tool", text: `${tool.name} → ${r.ok ? "ok" : "failed"}${r.verification ? ` (${r.verification})` : ""}`, at: new Date().toISOString() }).catch(() => undefined);
      const wrapped = `<tool_output app="${tool.connectorId}" trust="untrusted-data">\n${r.content}\n</tool_output>`;
      return r.ok ? okResult(toolUseId, wrapped) : errorResult(toolUseId, wrapped);
    } catch (e) {
      const msg = (e as Error).message;
      this.errors.push(`${tool.name}: ${msg}`);
      if (task?.id) await this.store.updateTask(task.id, { status: "failed", error: msg }).catch(() => undefined);
      return errorResult(toolUseId, `The ${tool.connectorId} tool failed: ${msg.slice(0, 300)}`);
    }
  }

  private async confirm(toolUseId: string, actionId: string): Promise<BetaToolResultBlockParam> {
    const p = this.pending.get(actionId);
    if (!p) return errorResult(toolUseId, "No pending action with that id.");
    if (Date.now() > p.expiresAt) {
      this.pending.delete(actionId);
      return errorResult(toolUseId, "That confirmation expired. Ask again if the caller still wants it.");
    }
    if (this.userTurn <= p.createdAtTurn) return errorResult(toolUseId, "The caller hasn't answered yet. Ask them and wait for their reply.");
    if (!AFFIRM.test(this.lastUserText) || NEGATE.test(this.lastUserText)) {
      return errorResult(toolUseId, `The caller's reply ("${this.lastUserText}") isn't a clear yes. Ask again or cancel.`);
    }
    if (this.pinRequired && !this.pinVerified) {
      this.awaitingPinFor = actionId;
      return okResult(toolUseId, "PIN_REQUIRED. Ask the caller to type their PIN on the keypad, then press pound. Don't call confirm_action again until the system says the PIN was entered.");
    }
    this.pending.delete(actionId);
    await this.store.audit({ actor: "caller", action: "confirmed_action", detail: { tool: p.tool.name, summary: p.summary, callSid: this.callSid }, at: new Date().toISOString() }).catch(() => undefined);
    if (this.completed.has(p.idempotencyKey)) return okResult(toolUseId, "Already done; not repeating it.");
    return this.execute(toolUseId, p.tool, p.input, p.summary, "consequential", p.idempotencyKey, p.taskId || undefined);
  }

  private async cancel(toolUseId: string, actionId: string): Promise<BetaToolResultBlockParam> {
    const p = this.pending.get(actionId);
    if (!p) return okResult(toolUseId, "Nothing pending with that id.");
    this.pending.delete(actionId);
    if (p.taskId) await this.store.updateTask(p.taskId, { status: "cancelled" }).catch(() => undefined);
    return okResult(toolUseId, "Cancelled. Nothing was done.");
  }

  verifyPin(digits: string): boolean {
    if (!this.cfg.VOICE_PIN) return true;
    const ok = digits === this.cfg.VOICE_PIN;
    if (ok) this.pinVerified = true;
    void this.store.audit({ actor: "caller", action: ok ? "pin_ok" : "pin_failed", detail: { callSid: this.callSid }, at: new Date().toISOString() }).catch(() => undefined);
    return ok;
  }

  private idempotencyKey(name: string, input: unknown) {
    return `${this.callSid}:${name}:${createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16)}`;
  }

  private async logTask(tool: CatalogTool, input: unknown, summary: string, status: "pending_confirmation" | "running" | "blocked", risk: Risk, key: string, result: string | null, error: string | null) {
    return this.store.createTask({
      callId: this.callId, integrationId: tool.connectorId, toolName: tool.name, summary, status, risk,
      input: redact(input), result, error, idempotencyKey: key,
    }).catch(() => null);
  }
}

function okResult(id: string, text: string): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text };
}
function errorResult(id: string, text: string): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text, is_error: true };
}
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
/** Keeps task history useful without storing whole email bodies. */
function redact(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof val === "string" && val.length > 300 ? `${val.slice(0, 300)}…` : val;
  }
  return out;
}
