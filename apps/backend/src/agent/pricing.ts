/** USD per million tokens. Cache writes are billed at 1.25x input (5-minute TTL). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** Claude web search: $10 per 1,000 searches, on top of tokens. */
export const WEB_SEARCH_USD = 0.01;

export function claudeCostUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return (u.input_tokens * p.input + write * p.input * 1.25 + read * p.cacheRead + u.output_tokens * p.output) / 1e6 + searches * WEB_SEARCH_USD;
}

/** Twilio inbound local number + ConversationRelay, per minute (US list prices, Oct 2026). */
export const TWILIO_PER_MINUTE = 0.0085 + 0.07;
export const TWILIO_NUMBER_MONTHLY = 1.15;

export function twilioCostUsd(seconds: number): number {
  return Math.ceil(seconds / 60) * TWILIO_PER_MINUTE;
}
