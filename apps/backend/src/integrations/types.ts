import type { Risk } from "../store/types.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool offered to Claude. `name` must be unique across all connectors. */
export interface ToolDescriptor {
  name: string; // namespaced, e.g. "gmail__search"
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** Connector-declared risk; may depend on the specific input. */
  risk?: Risk | ((input: Record<string, unknown>) => Risk);
  /** One spoken line describing what this call will do, used for confirmations. */
  describe?: (input: Record<string, unknown>) => string;
  /** True for the handful of tools that should always be visible (others load via tool search). */
  core?: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to Claude. Treated as untrusted data. */
  content: string;
  /** Short verification note (ids, links) recorded in task history. */
  verification?: string;
}

export interface Connector {
  id: string; // matches IntegrationRecord.id
  displayName: string;
  /** Tools available right now (may require network for MCP discovery). */
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  /** A safe, read-only live check. Only a passing test marks the integration connected. */
  test(): Promise<{ ok: boolean; detail: string; toolCount: number }>;
}

export function textResult(ok: boolean, content: unknown, verification?: string): ToolResult {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 1);
  return { ok, content: text.length > 12000 ? text.slice(0, 12000) + "\n…[truncated]" : text, verification };
}
