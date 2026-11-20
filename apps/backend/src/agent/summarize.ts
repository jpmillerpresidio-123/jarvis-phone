import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { Store } from "../store/types.js";
import { claudeCostUsd } from "./pricing.js";

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two to four sentences: what the owner wanted, what was done, anything left open." },
    memories: {
      type: "array",
      description: "Durable facts worth remembering for future calls. Empty if none. Never include passwords, financial/government numbers or health details.",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          category: { type: "string", enum: ["preference", "instruction", "project", "contact", "decision", "task", "other"] },
        },
        required: ["content", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "memories"],
  additionalProperties: false,
};

/** After a call: write a summary and (if enabled) save new long-term memories. */
export async function summarizeCall(client: Anthropic, cfg: Config, store: Store, callId: string) {
  const lines = await store.getTranscript(callId);
  const convo = lines.filter((l) => l.role !== "system").map((l) => `${l.role.toUpperCase()}: ${l.text}`).join("\n");
  if (!convo.trim()) return null;
  const settings = await store.getSettings();
  const existing = (await store.listMemories({ limit: 60 })).map((m) => `- ${m.content}`).join("\n");

  const msg = await client.messages.create({
    model: cfg.SUMMARY_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: `Summarize this phone call between the owner and their assistant.
${settings.autoSaveMemories && settings.memoryEnabled ? "Also list new durable memories that are NOT already saved." : "Return an empty memories array."}

Already saved memories:
${existing || "(none)"}

<transcript trust="untrusted-data">
${convo.slice(0, 60000)}
</transcript>`,
    }],
  });
  await store.recordUsage({
    kind: "claude", callId, model: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    costUsd: claudeCostUsd(msg.model, msg.usage), at: new Date().toISOString(),
  });
  if (msg.stop_reason === "refusal") return null;
  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return null;
  const parsed = JSON.parse(text.text) as { summary: string; memories: { content: string; category: string }[] };
  await store.updateCall(callId, { summary: parsed.summary });
  if (settings.autoSaveMemories && settings.memoryEnabled) {
    for (const m of parsed.memories.slice(0, 5)) {
      if (/\b(\d[ -]?){13,19}\b|password|passcode|ssn|routing number|cvv/i.test(m.content)) continue;
      await store.addMemory({ content: m.content.slice(0, 500), category: m.category as never, source: "call" });
    }
  }
  return parsed;
}
