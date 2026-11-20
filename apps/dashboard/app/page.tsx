"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, fmtDate, fmtDuration, usd, type Call, type Status, type Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Button, Card, Dot, Empty, Input, Notice, PageHeader, Skeleton, Stat, statusLabel, statusTone } from "@/components/ui";

export default function Overview() {
  const status = useApi<Status>("/api/status");
  const calls = useApi<Call[]>("/api/calls");
  const tasks = useApi<Task[]>("/api/tasks");
  const s = status.data;

  return (
    <>
      <PageHeader title="Overview" subtitle="How your assistant is doing right now." />
      {status.error && <Notice tone="bad">Couldn't reach the backend: {status.error}</Notice>}
      {s?.budgetWarning && <Notice tone="warn">You've used {usd(s.monthToDateUsd)} of your {usd(s.budgetUsd)} monthly budget.</Notice>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Assistant" value={s ? (s.ready ? <span className="flex items-center gap-2"><Dot tone="ok" />Live</span> : <span className="flex items-center gap-2"><Dot tone="warn" />Setup</span>) : <Skeleton className="h-8 w-20" />} sub={s?.phoneNumber ?? "No number configured"} />
        <Stat label="Calls this month" value={calls.data ? calls.data.filter((c) => c.startedAt >= monthStart()).length : "—"} sub={s?.lastCallAt ? `Last ${fmtDate(s.lastCallAt)}` : "No calls yet"} />
        <Stat label="Tasks completed" value={tasks.data ? tasks.data.filter((t) => t.status === "completed").length : "—"} sub={tasks.data ? `${tasks.data.filter((t) => t.status === "failed").length} failed` : ""} />
        <Stat label="Spend this month" value={s ? usd(s.monthToDateUsd) : "—"} sub={s ? `Budget ${usd(s.budgetUsd)}` : ""} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Recent calls" action={<Link href="/calls" className="text-[13px] text-accent">All calls</Link>}>
          {!calls.data ? <Skeleton className="h-24" /> : calls.data.length === 0 ? <Empty title="No calls yet">Call your assistant's number and it will show up here.</Empty> : (
            <ul className="divide-y divide-line">
              {calls.data.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link href={`/calls/${c.id}`} className="-mx-2 flex items-start justify-between gap-4 rounded-lg px-2 py-3 hover:bg-surface-2">
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium">{fmtDate(c.startedAt)}</div>
                      <div className="mt-0.5 line-clamp-1 text-[13px] text-muted">{c.summary ?? (c.status === "in_progress" ? "In progress…" : "No summary")}</div>
                    </div>
                    <div className="shrink-0 text-right text-[12.5px] text-muted">{fmtDuration(c.durationSec)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Integrations" action={<Link href="/connections" className="text-[13px] text-accent">Manage</Link>}>
          {!s ? <Skeleton className="h-24" /> : (
            <ul className="space-y-2.5">
              <li className="flex items-center justify-between text-[14px]"><span>Memory</span><Badge tone="ok">Built in</Badge></li>
              {s.integrations.length === 0 && <li className="text-[13px] text-muted">No apps connected yet.</li>}
              {s.integrations.map((i) => (
                <li key={i.id} className="flex items-center justify-between text-[14px]">
                  <span>{i.displayName}</span><Badge tone={statusTone(i.status)}>{statusLabel(i.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Recent tasks" action={<Link href="/tasks" className="text-[13px] text-accent">All tasks</Link>}>
          {!tasks.data ? <Skeleton className="h-24" /> : tasks.data.length === 0 ? <Empty title="No tasks yet" /> : (
            <ul className="space-y-3">
              {tasks.data.slice(0, 6).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-[14px]">{t.summary}</span>
                  <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <TryIt />
      </div>
    </>
  );
}

function monthStart() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }

/** Type to the same brain that answers the phone. */
function TryIt() {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [log, setLog] = useState<{ who: "you" | "assistant"; text: string }[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const msg = text.trim();
    setText("");
    setLog((l) => [...l, { who: "you", text: msg }]);
    setBusy(true);
    try {
      const r = await api<{ sessionId: string; reply: string }>("/api/assistant/message", { method: "POST", body: JSON.stringify({ text: msg, sessionId }) });
      setSessionId(r.sessionId);
      setLog((l) => [...l, { who: "assistant", text: r.reply || "(no reply)" }]);
    } catch (err) {
      setLog((l) => [...l, { who: "assistant", text: `Error: ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }
  return (
    <Card title="Try it by typing" action={log.length ? <Button variant="ghost" onClick={() => { setLog([]); setSessionId(undefined); }}>Reset</Button> : null}>
      <div className="mb-3 max-h-64 space-y-2 overflow-y-auto">
        {log.length === 0 && <p className="text-[13px] text-muted">Same assistant, same tools and confirmations as on the phone. Try "What's on my calendar tomorrow?"</p>}
        {log.map((m, i) => (
          <div key={i} className={m.who === "you" ? "text-right" : ""}>
            <span className={`inline-block max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] ${m.who === "you" ? "bg-ink text-bg" : "bg-surface-2"}`}>{m.text}</span>
          </div>
        ))}
        {busy && <div className="text-[13px] text-muted">Thinking…</div>}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask your assistant…" />
        <Button disabled={busy}>Send</Button>
      </form>
    </Card>
  );
}
