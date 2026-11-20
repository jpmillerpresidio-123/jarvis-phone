"use client";
import { useMemo, useState } from "react";
import { api, fmtDate, type Memory } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select, Skeleton, Textarea } from "@/components/ui";

const CATS = ["preference", "instruction", "project", "contact", "decision", "task", "other"];

export default function MemoryPage() {
  const { data, error, reload, setData } = useApi<Memory[]>("/api/memories");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [draft, setDraft] = useState({ content: "", category: "preference" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const list = useMemo(() => (data ?? []).filter((m) => (cat === "all" || m.category === cat) && (!q || m.content.toLowerCase().includes(q.toLowerCase()))), [data, q, cat]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.content.trim()) return;
    await api("/api/memories", { method: "POST", body: JSON.stringify(draft) });
    setDraft({ ...draft, content: "" });
    void reload();
  }
  async function patch(id: string, p: Partial<Memory>) {
    const m = await api<Memory>(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify(p) });
    setData((data ?? []).map((x) => (x.id === id ? m : x)));
  }
  async function remove(id: string) {
    if (!confirm("Delete this memory? This can't be undone.")) return;
    await api(`/api/memories/${id}`, { method: "DELETE" });
    setData((data ?? []).filter((x) => x.id !== id));
  }

  return (
    <>
      <PageHeader title="Memory" subtitle="What your assistant remembers about you. Pinned items are always in its mind." />
      {error && <Notice tone="bad">{error}</Notice>}
      <Card title="Add a memory" className="mb-6">
        <form onSubmit={add} className="flex flex-col gap-3 md:flex-row">
          <Input placeholder="e.g. I prefer meetings after 10am" value={draft.content} maxLength={2000} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
          <Select value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} options={CATS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))} />
          <Button>Save</Button>
        </form>
      </Card>
      <div className="mb-4 flex flex-col gap-3 md:flex-row">
        <Input placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={cat} onChange={setCat} options={[{ value: "all", label: "All categories" }, ...CATS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))]} />
      </div>
      {!data ? <Skeleton className="h-40" /> : list.length === 0 ? <Empty title="Nothing here yet">Memories are saved during calls when you share preferences or decisions, or you can add them above.</Empty> : (
        <div className="card divide-y divide-line">
          {list.map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                {editing === m.id ? (
                  <div className="space-y-2">
                    <Textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} />
                    <div className="flex gap-2"><Button onClick={async () => { await patch(m.id, { content: editText }); setEditing(null); }}>Save</Button><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                  </div>
                ) : <div className="text-[14.5px]">{m.content}</div>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <Badge>{m.category}</Badge>{m.pinned && <Badge tone="info">Pinned</Badge>}<span>From {m.source} · {fmtDate(m.updatedAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" onClick={() => patch(m.id, { pinned: !m.pinned })}>{m.pinned ? "Unpin" : "Pin"}</Button>
                <Button variant="ghost" onClick={() => { setEditing(m.id); setEditText(m.content); }}>Edit</Button>
                <Button variant="danger" onClick={() => remove(m.id)}>Delete</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
