export type Risk = "read" | "write" | "consequential" | "blocked";
export type ToolPolicy = "auto" | "confirm" | "block";

export interface AssistantSettings {
  assistantName: string;
  personality: string;
  responseStyle: "brief" | "balanced" | "detailed";
  greeting: string;
  ttsProvider: "ElevenLabs" | "Google" | "Amazon";
  voice: string | null;
  language: string;
  memoryEnabled: boolean;
  autoSaveMemories: boolean;
  confirmWrites: boolean;
  timezone: string;
  monthlyBudgetUsd: number | null;
  /** What the assistant calls the owner. */
  ownerName: string;
  /** Favorite teams, comma-separated names ("Warriors, 49ers"), for sports__team with no team given. */
  sportsTeams: string;
  /** Live web search for current questions (Claude's server-side web_search tool). */
  webSearch: boolean;
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  assistantName: "Assistant",
  personality: "Warm, direct and organized. Speaks like a capable human chief of staff.",
  responseStyle: "brief",
  greeting: "Hi, it's your assistant. What can I do for you?",
  ttsProvider: "ElevenLabs",
  voice: null,
  language: "en-US",
  memoryEnabled: true,
  autoSaveMemories: true,
  confirmWrites: false,
  timezone: "America/Los_Angeles",
  monthlyBudgetUsd: null,
  ownerName: "",
  sportsTeams: "",
  webSearch: true,
};

export interface Memory {
  id: string;
  content: string;
  category: "preference" | "instruction" | "project" | "contact" | "decision" | "task" | "other";
  pinned: boolean;
  source: "call" | "dashboard" | "assistant";
  createdAt: string;
  updatedAt: string;
}

export interface CallRecord {
  id: string;
  callSid: string;
  fromNumber: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  status: "in_progress" | "completed" | "failed" | "rejected";
  summary: string | null;
  errors: string[];
}

export interface TranscriptLine {
  callId: string;
  role: "caller" | "assistant" | "tool" | "system";
  text: string;
  at: string;
}

export interface TaskRecord {
  id: string;
  callId: string | null;
  integrationId: string;
  toolName: string;
  summary: string;
  status: "pending_confirmation" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  risk: Risk;
  input: unknown;
  result: string | null;
  error: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageEvent {
  kind: "claude" | "twilio";
  callId: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  minutes?: number;
  costUsd: number;
  at: string;
}

export interface IntegrationRecord {
  id: string; // e.g. "google", "shopify", "mcp:my-service"
  kind: "google" | "shopify" | "mcp";
  displayName: string;
  enabled: boolean;
  /** encrypted JSON blob holding tokens/keys; never sent to the dashboard */
  secret: string | null;
  config: Record<string, unknown>; // non-secret: shop domain, MCP URL, scopes, account email
  toolPolicies: Record<string, ToolPolicy>;
  status: "untested" | "connected" | "error" | "needs_auth" | "disconnected";
  lastTestedAt: string | null;
  lastError: string | null;
  toolCount: number;
}

export interface AuditEvent {
  actor: "caller" | "owner" | "system" | "assistant";
  action: string;
  detail: Record<string, unknown>;
  at: string;
}

export interface Store {
  getSettings(): Promise<AssistantSettings>;
  updateSettings(patch: Partial<AssistantSettings>): Promise<AssistantSettings>;

  createCall(c: Omit<CallRecord, "id">): Promise<CallRecord>;
  updateCall(id: string, patch: Partial<CallRecord>): Promise<void>;
  getCallBySid(callSid: string): Promise<CallRecord | null>;
  appendTranscript(line: TranscriptLine): Promise<void>;
  getTranscript(callId: string): Promise<TranscriptLine[]>;
  recentCalls(limit: number): Promise<CallRecord[]>;
  getCall(id: string): Promise<CallRecord | null>;

  createTask(t: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">): Promise<TaskRecord>;
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<void>;
  findTaskByKey(idempotencyKey: string): Promise<TaskRecord | null>;
  listTasks(opts: { status?: TaskRecord["status"]; callId?: string; limit?: number }): Promise<TaskRecord[]>;

  searchMemories(query: string, limit: number): Promise<Memory[]>;
  listMemories(opts?: { pinnedOnly?: boolean; limit?: number }): Promise<Memory[]>;
  addMemory(m: Pick<Memory, "content" | "category" | "source"> & { pinned?: boolean }): Promise<Memory>;
  deleteMemory(id: string): Promise<boolean>;
  updateMemory(id: string, patch: Partial<Pick<Memory, "content" | "category" | "pinned">>): Promise<Memory | null>;

  recordUsage(u: UsageEvent): Promise<void>;
  monthToDateCostUsd(): Promise<number>;
  usageSince(sinceIso: string): Promise<UsageEvent[]>;

  listIntegrations(): Promise<IntegrationRecord[]>;
  getIntegration(id: string): Promise<IntegrationRecord | null>;
  upsertIntegration(rec: IntegrationRecord): Promise<void>;
  deleteIntegration(id: string): Promise<void>;

  audit(e: AuditEvent): Promise<void>;
  listAudit(limit: number): Promise<AuditEvent[]>;
}
