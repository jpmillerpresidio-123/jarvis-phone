"use client";
import Link from "next/link";
import { useState } from "react";
import { fmtDate, type Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Empty, Notice, PageHeader, Skeleton, cx, statusLabel, statusTone } from "@/components/ui";

const TABS = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "pending_confirmation", label: "Pending" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
];

export default function TasksPage() {
  const [tab, setTab] = useState("all");
  const { data, error } = useApi<Task[]>(tab === "all" ? "/api/tasks" : `/api/tasks?status=${tab}`);
  return (
    <>
      <PageHeader title="Tasks" subtitle="Everything your assistant did, or was asked to do, in your apps." />
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="mb-5 inline-flex rounded-lg bg-surface-2 p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx("rounded-md px-3 py-1.5 text-[13px] transition", tab === t.id ? "bg-surface font-medium shadow-[var(--shadow)]" : "text-muted hover:text-ink")}>{t.label}</button>
        ))}
      </div>
      {!data ? <Skeleton className="h-48" /> : data.length === 0 ? <Empty title="No tasks here" /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13.5px]">
            <thead className="text-[12px] uppercase tracking-[0.05em] text-muted">
              <tr className="border-b border-line"><th className="px-5 py-3 font-medium">Task</th><th className="px-3 py-3 font-medium">App</th><th className="px-3 py-3 font-medium">Status</th><th className="px-3 py-3 font-medium">When</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="px-5 py-3.5">
                    <div className="font-medium">{t.summary}</div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-faint">{t.toolName}</div>
                    {t.error && <div className="mt-1 text-[12.5px] text-bad">{t.error}</div>}
                    {t.callId && <Link href={`/calls/${t.callId}`} className="mt-1 inline-block text-[12.5px] text-accent">View call</Link>}
                  </td>
                  <td className="px-3 py-3.5 text-muted">{t.integrationId}</td>
                  <td className="px-3 py-3.5"><Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge></td>
                  <td className="px-3 py-3.5 whitespace-nowrap text-muted">{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
