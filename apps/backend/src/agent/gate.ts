import type { Risk, ToolPolicy } from "../store/types.js";
import type { ToolDescriptor } from "../integrations/types.js";

/**
 * Decides how risky a tool call is. Order of precedence:
 *  1. Hard blocks (outbound calling, purchases, payments) — never overridable.
 *  2. The owner's per-tool policy from the dashboard.
 *  3. The connector's own declared risk.
 *  4. MCP annotations (readOnlyHint / destructiveHint).
 *  5. Name heuristics. Anything unknown is treated as consequential.
 */

const HARD_BLOCK = [
  /\b(make|place|create|start|initiate)_?(outbound_)?(phone_)?call/i,
  /(^|_)(dial|outbound_call|calls_create|create_call)($|_)/i,
  /(^|_)(purchase|buy|checkout|pay|payment|charge|transfer_funds|top_?up|add_credits|subscribe|upgrade_plan|rent)($|_)/i,
  /(^|_)(gpu_rent|manage_credits|cancel_subscription)($|_)/i,
];

const CONSEQUENTIAL = /(^|_)(send|reply|forward|delete|trash|remove|share|publish|unpublish|post|invite|deploy|archive|refund|cancel|generate|render|upload|spam|order|fulfill|revoke|grant|respond)/i;
const WRITE = /(^|_)(create|update|add|set|move|label|unlabel|draft|insert|append|edit|rename|copy|tag|mark|untrash|clear)/i;
const READ = /(^|_)(get|list|search|read|find|query|fetch|describe|show|lookup|check|preview|status|download|retrieve|count|suggest|explore)/i;

export function isHardBlocked(toolName: string): boolean {
  const bare = toolName.split("__").pop() ?? toolName;
  return HARD_BLOCK.some((re) => re.test(bare));
}

export function classify(
  tool: ToolDescriptor,
  input: Record<string, unknown>,
  policy: ToolPolicy | undefined,
  confirmWrites: boolean,
): Risk {
  if (isHardBlocked(tool.name)) return "blocked";
  if (policy === "block") return "blocked";
  if (policy === "confirm") return "consequential";

  let risk: Risk | undefined =
    typeof tool.risk === "function" ? tool.risk(input) : tool.risk;

  if (!risk && tool.annotations) {
    if (tool.annotations.readOnlyHint) risk = "read";
    else if (tool.annotations.destructiveHint) risk = "consequential";
  }
  if (!risk) {
    const bare = tool.name.split("__").pop() ?? tool.name;
    if (CONSEQUENTIAL.test(bare)) risk = "consequential";
    else if (WRITE.test(bare)) risk = "write";
    else if (READ.test(bare)) risk = "read";
    else risk = "consequential";
  }

  if (policy === "auto" && risk !== "blocked") return risk === "consequential" ? "write" : risk;
  if (risk === "write" && confirmWrites) return "consequential";
  return risk;
}
