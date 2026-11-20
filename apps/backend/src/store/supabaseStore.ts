import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  type AssistantSettings,
  type AuditEvent,
  type CallRecord,
  type IntegrationRecord,
  type Memory,
  type Store,
  type TaskRecord,
  type TranscriptLine,
  type UsageEvent,
} from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`Supabase: ${res.error.message}`);
  return res.data;
}

const toCall = (r: Row): CallRecord => ({
  id: r.id, callSid: r.call_sid, fromNumber: r.from_number, startedAt: r.started_at,
  endedAt: r.ended_at, durationSec: r.duration_sec, status: r.status, summary: r.summary, errors: r.errors ?? [],
});
const toMemory = (r: Row): Memory => ({
  id: r.id, content: r.content, category: r.category, pinned: r.pinned, source: r.source,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toTask = (r: Row): TaskRecord => ({
  id: r.id, callId: r.call_id, integrationId: r.integration_id, toolName: r.tool_name, summary: r.summary,
  status: r.status, risk: r.risk, input: r.input, result: r.result, error: r.error,
  idempotencyKey: r.idempotency_key, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toIntegration = (r: Row): IntegrationRecord => ({
  id: r.id, kind: r.kind, displayName: r.display_name, enabled: r.enabled, secret: r.secret,
  config: r.config ?? {}, toolPolicies: r.tool_policies ?? {}, status: r.status,
  lastTestedAt: r.last_tested_at, lastError: r.last_error, toolCount: r.tool_count,
});

export class SupabaseStore implements Store {
  private db: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  get client() { return this.db; }

  async getSettings(): Promise<AssistantSettings> {
    const row = must(await this.db.from("settings").select("data").eq("id", true).maybeSingle());
    return { ...DEFAULT_SETTINGS, ...((row as Row | null)?.data ?? {}) };
  }
  async updateSettings(patch: Partial<AssistantSettings>) {
    const next = { ...(await this.getSettings()), ...patch };
    must(await this.db.from("settings").upsert({ id: true, data: next, updated_at: new Date().toISOString() }));
    return next;
  }

  async createCall(c: Omit<CallRecord, "id">) {
    const row = must(await this.db.from("calls").upsert({
      call_sid: c.callSid, from_number: c.fromNumber, started_at: c.startedAt, ended_at: c.endedAt,
      duration_sec: c.durationSec, status: c.status, summary: c.summary, errors: c.errors,
    }, { onConflict: "call_sid" }).select().single());
    return toCall(row as Row);
  }
  async updateCall(id: string, p: Partial<CallRecord>) {
    const row: Row = {};
    if (p.endedAt !== undefined) row.ended_at = p.endedAt;
    if (p.durationSec !== undefined) row.duration_sec = p.durationSec;
    if (p.status !== undefined) row.status = p.status;
    if (p.summary !== undefined) row.summary = p.summary;
    if (p.errors !== undefined) row.errors = p.errors;
    must(await this.db.from("calls").update(row).eq("id", id));
  }
  async getCallBySid(callSid: string) {
    const row = must(await this.db.from("calls").select().eq("call_sid", callSid).maybeSingle());
    return row ? toCall(row as Row) : null;
  }
  async getCall(id: string) {
    const row = must(await this.db.from("calls").select().eq("id", id).maybeSingle());
    return row ? toCall(row as Row) : null;
  }
  async appendTranscript(l: TranscriptLine) {
    must(await this.db.from("transcript_lines").insert({ call_id: l.callId, role: l.role, text: l.text, at: l.at }));
  }
  async getTranscript(callId: string) {
    const rows = must(await this.db.from("transcript_lines").select().eq("call_id", callId).order("id"));
    return (rows as Row[]).map((r) => ({ callId: r.call_id, role: r.role, text: r.text, at: r.at }));
  }
  async recentCalls(limit: number) {
    const rows = must(await this.db.from("calls").select().order("started_at", { ascending: false }).limit(limit));
    return (rows as Row[]).map(toCall);
  }

  async createTask(t: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">) {
    const row = must(await this.db.from("tasks").insert({
      call_id: t.callId, integration_id: t.integrationId, tool_name: t.toolName, summary: t.summary,
      status: t.status, risk: t.risk, input: t.input, result: t.result, error: t.error, idempotency_key: t.idempotencyKey,
    }).select().single());
    return toTask(row as Row);
  }
  async updateTask(id: string, p: Partial<TaskRecord>) {
    const row: Row = { updated_at: new Date().toISOString() };
    if (p.status !== undefined) row.status = p.status;
    if (p.result !== undefined) row.result = p.result;
    if (p.error !== undefined) row.error = p.error;
    must(await this.db.from("tasks").update(row).eq("id", id));
  }
  async findTaskByKey(key: string) {
    const row = must(await this.db.from("tasks").select().eq("idempotency_key", key).maybeSingle());
    return row ? toTask(row as Row) : null;
  }

  async listTasks(opts: { status?: TaskRecord["status"]; callId?: string; limit?: number }) {
    let q = this.db.from("tasks").select().order("created_at", { ascending: false }).limit(opts.limit ?? 100);
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.callId) q = q.eq("call_id", opts.callId);
    return (must(await q) as Row[]).map(toTask);
  }

  async searchMemories(query: string, limit: number) {
    const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2).slice(0, 12);
    if (!terms.length) return [];
    const rows = must(await this.db.from("memories").select()
      .textSearch("search", terms.join(" | "), { config: "english" }).limit(limit));
    return (rows as Row[]).map(toMemory);
  }
  async listMemories(opts: { pinnedOnly?: boolean; limit?: number } = {}) {
    let q = this.db.from("memories").select().order("updated_at", { ascending: false }).limit(opts.limit ?? 200);
    if (opts.pinnedOnly) q = q.eq("pinned", true);
    return (must(await q) as Row[]).map(toMemory);
  }
  async addMemory(m: Pick<Memory, "content" | "category" | "source"> & { pinned?: boolean }) {
    const row = must(await this.db.from("memories").insert({
      content: m.content, category: m.category, source: m.source, pinned: m.pinned ?? false,
    }).select().single());
    return toMemory(row as Row);
  }
  async deleteMemory(id: string) {
    const rows = must(await this.db.from("memories").delete().eq("id", id).select("id"));
    return (rows as Row[]).length > 0;
  }

  async updateMemory(id: string, patch: Partial<Pick<Memory, "content" | "category" | "pinned">>) {
    const row = must(await this.db.from("memories").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().maybeSingle());
    return row ? toMemory(row as Row) : null;
  }

  async recordUsage(u: UsageEvent) {
    must(await this.db.from("usage_events").insert({
      kind: u.kind, call_id: u.callId, model: u.model, input_tokens: u.inputTokens, output_tokens: u.outputTokens,
      cache_read_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens, minutes: u.minutes,
      cost_usd: u.costUsd, at: u.at,
    }));
  }
  async monthToDateCostUsd() {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const rows = must(await this.db.from("usage_events").select("cost_usd").gte("at", start.toISOString()));
    return (rows as Row[]).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  }

  async usageSince(sinceIso: string) {
    const rows = must(await this.db.from("usage_events").select().gte("at", sinceIso).order("at").limit(10000));
    return (rows as Row[]).map((r) => ({
      kind: r.kind, callId: r.call_id, model: r.model ?? undefined, inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0,
      cacheReadTokens: r.cache_read_tokens ?? 0, cacheWriteTokens: r.cache_write_tokens ?? 0, minutes: Number(r.minutes ?? 0),
      costUsd: Number(r.cost_usd ?? 0), at: r.at,
    }));
  }

  async listIntegrations() {
    return (must(await this.db.from("integrations").select()) as Row[]).map(toIntegration);
  }
  async getIntegration(id: string) {
    const row = must(await this.db.from("integrations").select().eq("id", id).maybeSingle());
    return row ? toIntegration(row as Row) : null;
  }
  async upsertIntegration(r: IntegrationRecord) {
    must(await this.db.from("integrations").upsert({
      id: r.id, kind: r.kind, display_name: r.displayName, enabled: r.enabled, secret: r.secret, config: r.config,
      tool_policies: r.toolPolicies, status: r.status, last_tested_at: r.lastTestedAt, last_error: r.lastError,
      tool_count: r.toolCount, updated_at: new Date().toISOString(),
    }));
  }
  async deleteIntegration(id: string) {
    must(await this.db.from("integrations").delete().eq("id", id));
  }

  async audit(e: AuditEvent) {
    must(await this.db.from("audit_log").insert({ actor: e.actor, action: e.action, detail: e.detail, at: e.at }));
  }

  async listAudit(limit: number) {
    const rows = must(await this.db.from("audit_log").select().order("at", { ascending: false }).limit(limit));
    return (rows as Row[]).map((r) => ({ actor: r.actor, action: r.action, detail: r.detail, at: r.at }));
  }

  /** Ensures the owner row exists so dashboard RLS admits the owner. */
  async ensureOwner(email: string) {
    must(await this.db.from("app_owner").upsert({ id: true, email }));
  }
}
