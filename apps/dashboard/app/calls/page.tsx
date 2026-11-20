"use client";
import Link from "next/link";
import { fmtDate, fmtDuration, type Call } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Empty, Notice, PageHeader, Skeleton, statusLabel, statusTone } from "@/components/ui";

export default function CallsPage() {
  const { data, error } = useApi<Call[]>("/api/calls");
  return (
    <>
      <PageHeader title="Call History" subtitle="Transcripts and summaries of every call. Audio is never recorded." />
      {error && <Notice tone="bad">{error}</Notice>}
      {!data ? <Skeleton className="h-48" /> : data.length === 0 ? <Empty title="No calls yet">When you call your assistant, the conversation appears here.</Empty> : (
        <div className="card divide-y divide-line">
          {data.map((c) => (
            <Link key={c.id} href={`/calls/${c.id}`} className="flex items-start justify-between gap-4 px-5 py-4 transition hover:bg-surface-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className="text-[14.5px] font-medium">{fmtDate(c.startedAt)}</span><Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>{c.errors.length > 0 && <Badge tone="bad">{c.errors.length} error{c.errors.length > 1 ? "s" : ""}</Badge>}</div>
                <div className="mt-1 line-clamp-2 text-[13.5px] text-muted">{c.summary ?? "No summary yet."}</div>
              </div>
              <div className="shrink-0 text-right text-[12.5px] text-muted"><div>{fmtDuration(c.durationSec)}</div><div className="mt-0.5">{c.fromNumber}</div></div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
