import { randomUUID } from "node:crypto";
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

/** In-process store for local development and tests. Data is lost on restart. */
export class InMemoryStore implements Store {
  settings: AssistantSettings = { ...DEFAULT_SETTINGS };
  calls = new Map<string, CallRecord>();
  transcript: TranscriptLine[] = [];
  tasks = new Map<string, TaskRecord>();
  memories = new Map<string, Memory>();
  usage: UsageEvent[] = [];
  integrations = new Map<string, IntegrationRecord>();
  audits: AuditEvent[] = [];

  async getSettings() { return { ...this.settings }; }
  async updateSettings(patch: Partial<AssistantSettings>) {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  async createCall(c: Omit<CallRecord, "id">) {
    const rec = { ...c, id: randomUUID() };
    this.calls.set(rec.id, rec);
    return rec;
  }
  async updateCall(id: string, patch: Partial<CallRecord>) {
    const c = this.calls.get(id);
    if (c) this.calls.set(id, { ...c, ...patch });
  }
  async getCallBySid(callSid: string) {
    return [...this.calls.values()].find((c) => c.callSid === callSid) ?? null;
  }
  async getCall(id: string) { return this.calls.get(id) ?? null; }
  async appendTranscript(line: TranscriptLine) { this.transcript.push(line); }
  async getTranscript(callId: string) { return this.transcript.filter((l) => l.callId === callId); }
  async recentCalls(limit: number) {
    return [...this.calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async createTask(t: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const rec = { ...t, id: randomUUID(), createdAt: now, updatedAt: now };
    this.tasks.set(rec.id, rec);
    return rec;
  }
  async updateTask(id: string, patch: Partial<TaskRecord>) {
    const t = this.tasks.get(id);
    if (t) this.tasks.set(id, { ...t, ...patch, updatedAt: new Date().toISOString() });
  }
  async findTaskByKey(key: string) {
    return [...this.tasks.values()].find((t) => t.idempotencyKey === key) ?? null;
  }

  async listTasks(opts: { status?: TaskRecord["status"]; callId?: string; limit?: number }) {
    return [...this.tasks.values()]
      .filter((t) => (!opts.status || t.status === opts.status) && (!opts.callId || t.callId === opts.callId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 100);
  }

  async searchMemories(query: string, limit: number) {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scored = [...this.memories.values()]
      .map((m) => ({ m, s: words.filter((w) => m.content.toLowerCase().includes(w)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.m);
  }
  async listMemories(opts: { pinnedOnly?: boolean; limit?: number } = {}) {
    return [...this.memories.values()]
      .filter((m) => !opts.pinnedOnly || m.pinned)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, opts.limit ?? 200);
  }
  async addMemory(m: Pick<Memory, "content" | "category" | "source"> & { pinned?: boolean }) {
    const now = new Date().toISOString();
    const rec: Memory = { id: randomUUID(), pinned: false, ...m, createdAt: now, updatedAt: now };
    this.memories.set(rec.id, rec);
    return rec;
  }
  async deleteMemory(id: string) { return this.memories.delete(id); }
  async updateMemory(id: string, patch: Partial<Pick<Memory, "content" | "category" | "pinned">>) {
    const m = this.memories.get(id);
    if (!m) return null;
    const next = { ...m, ...patch, updatedAt: new Date().toISOString() };
    this.memories.set(id, next);
    return next;
  }

  async recordUsage(u: UsageEvent) { this.usage.push(u); }
  async monthToDateCostUsd() {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return this.usage.filter((u) => u.at >= start.toISOString()).reduce((s, u) => s + u.costUsd, 0);
  }

  async usageSince(sinceIso: string) { return this.usage.filter((u) => u.at >= sinceIso); }

  async listIntegrations() { return [...this.integrations.values()]; }
  async getIntegration(id: string) { return this.integrations.get(id) ?? null; }
  async upsertIntegration(rec: IntegrationRecord) { this.integrations.set(rec.id, rec); }
  async deleteIntegration(id: string) { this.integrations.delete(id); }

  async audit(e: AuditEvent) { this.audits.push(e); }
  async listAudit(limit: number) { return [...this.audits].reverse().slice(0, limit); }
}
