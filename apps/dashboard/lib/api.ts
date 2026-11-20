"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
/** Local development without Supabase: the backend accepts this token only outside production. */
const DEV_TOKEN = process.env.NEXT_PUBLIC_DEV_TOKEN ?? "";

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON) return null;
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });
  return client;
}
export const devMode = !SUPABASE_URL && Boolean(DEV_TOKEN);

export async function accessToken(): Promise<string | null> {
  const sb = supabase();
  if (!sb) return DEV_TOKEN || null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Not signed in");
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ? `${data.error}${data.issues ? `: ${data.issues.join(", ")}` : ""}` : `Request failed (${res.status})`);
  return data as T;
}

export const usd = (n: number) => (n < 1 && n > 0 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const fmtDuration = (s: number | null) => (s == null ? "—" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
export const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact" }).format(n);

// Shared response types (mirror the backend)
export interface Integration {
  id: string; kind: "google" | "shopify" | "mcp"; displayName: string; enabled: boolean; hasCredentials: boolean;
  config: Record<string, unknown>; toolPolicies: Record<string, "auto" | "confirm" | "block">;
  status: "untested" | "connected" | "error" | "needs_auth" | "disconnected"; lastTestedAt: string | null; lastError: string | null; toolCount: number;
}
export interface Status {
  config: Record<string, boolean | number | string>; phoneNumber: string | null; integrations: Integration[];
  monthToDateUsd: number; budgetUsd: number; budgetWarning: boolean; lastCallAt: string | null; ready: boolean;
}
export interface Call { id: string; callSid: string; fromNumber: string; startedAt: string; endedAt: string | null; durationSec: number | null; status: string; summary: string | null; errors: string[] }
export interface Task { id: string; callId: string | null; integrationId: string; toolName: string; summary: string; status: string; risk: string; result: string | null; error: string | null; createdAt: string }
export interface Memory { id: string; content: string; category: string; pinned: boolean; source: string; createdAt: string; updatedAt: string }
export interface Settings {
  assistantName: string; personality: string; responseStyle: "brief" | "balanced" | "detailed"; greeting: string;
  ttsProvider: "ElevenLabs" | "Google" | "Amazon"; voice: string | null; language: string; memoryEnabled: boolean;
  autoSaveMemories: boolean; confirmWrites: boolean; timezone: string; monthlyBudgetUsd: number | null;
  /** Jarvis brain: what it calls you, favorite teams for scores, and live web search. */
  ownerName: string; sportsTeams: string; webSearch: boolean;
}
