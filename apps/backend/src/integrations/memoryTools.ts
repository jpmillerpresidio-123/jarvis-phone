import type { Store } from "../store/types.js";
import type { Connector, ToolDescriptor, ToolResult } from "./types.js";
import { textResult } from "./types.js";

const CATEGORIES = ["preference", "instruction", "project", "contact", "decision", "task", "other"] as const;

/** Built-in memory tools backed by Supabase. Always available. */
export class MemoryConnector implements Connector {
  id = "memory";
  displayName = "Memory";
  constructor(private store: Store) {}

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        name: "memory__remember", core: true, risk: "write",
        description: "Save a durable fact the owner would want remembered across calls (preference, instruction, ongoing project, contact detail, decision). Never save passwords, card or account numbers, health details or other sensitive data.",
        inputSchema: { type: "object", properties: { content: { type: "string", maxLength: 500 }, category: { type: "string", enum: CATEGORIES } }, required: ["content", "category"], additionalProperties: false },
      },
      {
        name: "memory__recall", core: true, risk: "read",
        description: "Search saved memories and past call summaries for something the owner mentioned before.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      },
      {
        name: "memory__forget", core: true, risk: "consequential",
        description: "Delete a saved memory by id (from memory__recall).",
        inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"], additionalProperties: false },
        describe: () => "delete that saved memory",
      },
    ];
  }

  async callTool(name: string, i: Record<string, unknown>): Promise<ToolResult> {
    const settings = await this.store.getSettings();
    if (!settings.memoryEnabled && name !== "memory__forget") return textResult(false, "Memory is turned off in settings.");
    if (name === "memory__remember") {
      const content = String(i.content ?? "").trim();
      if (!content) return textResult(false, "Nothing to remember.");
      if (/\b(\d[ -]?){13,19}\b|password|passcode|ssn|social security|routing number|cvv/i.test(content)) {
        return textResult(false, "That looks sensitive, so I didn't save it.");
      }
      const cat = CATEGORIES.includes(i.category as (typeof CATEGORIES)[number]) ? (i.category as (typeof CATEGORIES)[number]) : "other";
      const m = await this.store.addMemory({ content, category: cat, source: "call" });
      return textResult(true, `Saved (memory id ${m.id}).`, `memory:${m.id}`);
    }
    if (name === "memory__recall") {
      const q = String(i.query ?? "");
      const [mems, calls] = await Promise.all([this.store.searchMemories(q, 8), this.store.recentCalls(10)]);
      const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const relatedCalls = calls.filter((c) => c.summary && words.some((w) => c.summary!.toLowerCase().includes(w))).slice(0, 3);
      return textResult(true, {
        memories: mems.map((m) => ({ id: m.id, content: m.content, category: m.category, saved: m.createdAt.slice(0, 10) })),
        previousCalls: relatedCalls.map((c) => ({ date: c.startedAt.slice(0, 10), summary: c.summary })),
      });
    }
    if (name === "memory__forget") {
      const ok = await this.store.deleteMemory(String(i.memory_id ?? ""));
      return textResult(ok, ok ? "Deleted." : "No memory with that id.");
    }
    return textResult(false, `Unknown memory tool ${name}`);
  }

  async test() { return { ok: true, detail: "Built in", toolCount: 3 }; }
}
