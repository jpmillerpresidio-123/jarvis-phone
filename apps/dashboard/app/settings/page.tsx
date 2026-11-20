"use client";
import { fmtDate, supabase, type Status } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { SettingsForm } from "@/components/SettingsForm";
import { Badge, Card, Input, PageHeader, Row, Skeleton } from "@/components/ui";

const ENV_LABELS: Record<string, string> = {
  claude: "Claude API key", twilio: "Twilio account + number", supabase: "Supabase database", owner: "Owner email",
  encryption: "Credential encryption key", google: "Google OAuth client", voicePin: "Voice PIN",
};

export default function SettingsPage() {
  const status = useApi<Status>("/api/status");
  const audit = useApi<{ actor: string; action: string; detail: Record<string, unknown>; at: string }[]>("/api/audit");
  const c = status.data?.config;
  return (
    <>
      <PageHeader title="Settings" subtitle="Account, security and server configuration." />
      <div className="space-y-6">
        <Card title="Account">
          <Row label="Sign-in" hint="Email magic link through Supabase. Only the owner email configured on the server is allowed in."><Badge tone="ok">Owner only</Badge></Row>
          {supabase() && <Row label="Sign out of this browser"><button className="text-[13.5px] text-accent" onClick={() => supabase()!.auth.signOut()}>Sign out</button></Row>}
        </Card>

        <SettingsForm>
          {(d, set) => (
            <Card title="Budget">
              <Row label="Monthly budget warning" hint="You'll see a warning at 80%. Nothing is ever upgraded or purchased automatically.">
                <Input className="max-w-[140px]" type="number" min={0} step={5} value={d.monthlyBudgetUsd ?? ""} placeholder="50" onChange={(e) => set("monthlyBudgetUsd", e.target.value === "" ? null : Number(e.target.value))} />
              </Row>
            </Card>
          )}
        </SettingsForm>

        <Card title="Security">
          <Row label="Secrets" hint="API keys and OAuth tokens live only on the server, encrypted with AES-256-GCM. The browser never sees them."><Badge tone="ok">Server-side</Badge></Row>
          <Row label="Sensitive actions" hint="Sending, deleting, sharing, inviting and spending credits need your spoken yes."><Badge tone="ok">Confirmed</Badge></Row>
          <Row label="Blocked always" hint="Outbound calls, purchases, payments, buying credits."><Badge tone="bad">Never allowed</Badge></Row>
          <Row label="Prompt-injection guard" hint="Email and document content is treated as data, never as instructions."><Badge tone="ok">On</Badge></Row>
        </Card>

        <Card title="Environment configuration">
          {!c ? <Skeleton className="h-40" /> : Object.entries(ENV_LABELS).map(([k, label]) => (
            <Row key={k} label={label}><Badge tone={c[k] ? "ok" : k === "voicePin" ? "neutral" : k === "google" ? "warn" : "bad"}>{c[k] ? "Configured" : "Missing"}</Badge></Row>
          ))}
          {c && <Row label="Allowed callers"><Badge tone={Number(c.allowedCallers) ? "ok" : "bad"}>{String(c.allowedCallers)}</Badge></Row>}
        </Card>

        <Card title="Audit log">
          {!audit.data ? <Skeleton className="h-24" /> : audit.data.length === 0 ? <p className="text-[13px] text-muted">No events yet.</p> : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {audit.data.map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
                  <span><span className="font-medium">{a.action.replace(/_/g, " ")}</span> <span className="text-muted">by {a.actor}</span></span>
                  <span className="shrink-0 text-muted">{fmtDate(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
