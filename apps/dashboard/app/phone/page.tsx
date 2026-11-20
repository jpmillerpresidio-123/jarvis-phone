"use client";
import { API_URL, type Status } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Card, Dot, Notice, PageHeader, Row, Skeleton } from "@/components/ui";

export default function PhonePage() {
  const { data: s, error } = useApi<Status>("/api/status");
  const c = s?.config;
  return (
    <>
      <PageHeader title="Phone" subtitle="Your assistant's number and how calls are handled." />
      {error && <Notice tone="bad">{error}</Notice>}
      {!s ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-[13px] text-muted">Assistant number</div>
                <div className="mt-1 text-[30px] font-semibold tracking-[-0.02em] tabular-nums">{s.phoneNumber ?? "Not set up"}</div>
              </div>
              {s.ready ? <Badge tone="ok"><Dot tone="ok" />Answering calls</Badge> : <Badge tone="warn">Setup incomplete</Badge>}
            </div>
          </Card>
          <Card title="Incoming calls">
            <Row label="Direction" hint="The assistant never places calls. Outbound calling is blocked in code and in the Twilio key."><Badge>Incoming only</Badge></Row>
            <Row label="Allowed callers" hint="Only these numbers reach the assistant (set ALLOWED_CALLERS on the server)."><Badge tone={Number(c?.allowedCallers) > 0 ? "ok" : "bad"}>{String(c?.allowedCallers ?? 0)} number(s)</Badge></Row>
            <Row label="Keypad PIN" hint="Not used. Sensitive actions are confirmed by voice."><Badge>{c?.voicePin ? "On" : "Off"}</Badge></Row>
            <Row label="Interruptions" hint="You can talk over the assistant at any time."><Badge tone="ok">On</Badge></Row>
            <Row label="Call recording" hint="Audio is never recorded. Text transcripts are kept in Call History."><Badge>Off</Badge></Row>
          </Card>
          <Card title="Connection">
            <Row label="Twilio credentials"><Badge tone={c?.twilio ? "ok" : "bad"}>{c?.twilio ? "Configured" : "Missing"}</Badge></Row>
            <Row label="Voice webhook (A call comes in → POST)"><code className="rounded bg-surface-2 px-2 py-1 font-mono text-[12.5px]">{String(c?.publicBaseUrl ?? API_URL)}/voice</code></Row>
            <Row label="Live voice socket"><code className="rounded bg-surface-2 px-2 py-1 font-mono text-[12.5px]">{String(c?.publicBaseUrl ?? API_URL).replace(/^http/, "ws")}/relay</code></Row>
            <Row label="Model"><code className="font-mono text-[12.5px]">{String(c?.model)}</code></Row>
          </Card>
        </div>
      )}
    </>
  );
}
