"use client";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Settings } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button, Notice, Skeleton } from "./ui";

/** Loads settings, lets children edit a draft, and saves only changed fields. */
export function SettingsForm({ children }: { children: (draft: Settings, set: <K extends keyof Settings>(k: K, v: Settings[K]) => void) => ReactNode }) {
  const { data, error, setData } = useApi<Settings>("/api/settings");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  useEffect(() => { if (data) setDraft(data); }, [data]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!draft || !data) return <Skeleton className="h-64" />;
  const changed = (Object.keys(draft) as (keyof Settings)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(data[k]));
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, draft![k]]));
      const next = await api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      setData(next);
      setMsg({ tone: "ok", text: "Saved. New calls use these settings." });
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {children(draft, set)}
      <div className="sticky bottom-4 flex justify-end gap-2">
        {changed.length > 0 && <Button variant="secondary" onClick={() => setDraft(data)}>Discard</Button>}
        <Button disabled={!changed.length || saving} onClick={save}>{saving ? "Saving…" : changed.length ? `Save ${changed.length} change${changed.length > 1 ? "s" : ""}` : "Saved"}</Button>
      </div>
    </div>
  );
}
