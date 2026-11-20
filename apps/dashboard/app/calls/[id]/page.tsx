"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fmtDate, fmtDuration, type Call, type Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Card, Empty, Notice, PageHeader, Skeleton, cx, statusLabel, statusTone } from "@/components/ui";

interface Detail { call: Call; transcript: { role: string; text: string; at: string }[]; tasks: Task[] }

export default function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<Detail>(`/api/calls/${encodeURIComponent(id)}`);
  const c = data?.call;
  return (
    <>
      <Link href="/calls" className="mb-4 inline-block text-[13px] text-muted hover:text-ink">← Call History</Link>
      <PageHeader title={c ? fmtDate(c.startedAt) : "Call"} subtitle={c ? `${fmtDuration(c.durationSec)} · from ${c.fromNumber}` : undefined} action={c && <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>} />
      {error && <Notice tone="bad">{error}</Notice>}
      {!data ? <Skeleton className="h-64" /> : (
        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <Card title="Transcript">
            {data.transcript.length === 0 ? <Empty title="No transcript" /> : (
              <div className="space-y-3">
                {data.transcript.map((l, i) => l.role === "tool" ? (
                  <div key={i} className="text-center font-mono text-[11.5px] text-faint">{l.text}</div>
                ) : (
                  <div key={i} className={cx(l.role === "caller" && "text-right")}>
                    <div className="mb-0.5 text-[11.5px] text-faint">{l.role === "caller" ? "You" : "Assistant"}</div>
                    <span className={cx("inline-block max-w-[88%] rounded-2xl px-3.5 py-2 text-left text-[14px]", l.role === "caller" ? "bg-ink text-bg" : "bg-surface-2")}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <div className="space-y-6">
            <Card title="Summary"><p className="text-[14px] leading-relaxed">{c?.summary ?? "The summary is written a few seconds after the call ends."}</p></Card>
            <Card title="Tasks">
              {data.tasks.length === 0 ? <p className="text-[13px] text-muted">No tasks on this call.</p> : (
                <ul className="space-y-2.5">{data.tasks.map((t) => <li key={t.id} className="flex items-center justify-between gap-3 text-[13.5px]"><span className="min-w-0 truncate">{t.summary}</span><Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge></li>)}</ul>
              )}
            </Card>
            {c && c.errors.length > 0 && <Card title="Errors"><ul className="space-y-1.5 text-[13px] text-bad">{c.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Card>}
          </div>
        </div>
      )}
    </>
  );
}
