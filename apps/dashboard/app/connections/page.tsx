"use client";
import { useEffect, useState } from "react";
import { api, fmtDate, type Integration } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Select, Skeleton, statusLabel, statusTone } from "@/components/ui";

interface Option { id: string; kind: string; name: string; covers: string; auth: string; availability: "available" | "builtin" | "unavailable"; reason?: string }
interface Conn { options: Option[]; integrations: Integration[]; googleConfigured: boolean; googleScopes: string[] }
interface Tool { name: string; description: string; defaultRisk: string; policy: "auto" | "confirm" | "block" | null }

const riskTone = (r: string) => ({ read: "ok", write: "info", consequential: "warn", blocked: "bad" } as const)[r as "read"] ?? "neutral";
const riskLabel = (r: string) => ({ read: "Runs freely", write: "Runs, logged", consequential: "Asks first", blocked: "Never" } as Record<string, string>)[r] ?? r;

export default function Connections() {
  const { data, error, reload } = useApi<Conn>("/api/connections");
  const [flash, setFlash] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [adding, setAdding] = useState<"shopify" | "mcp" | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setFlash({ tone: "ok", text: `Connected and tested: ${q.get("connected")}` });
    if (q.get("error")) setFlash({ tone: "bad", text: q.get("error")! });
    if (q.size) window.history.replaceState(null, "", "/connections");
  }, []);

  async function connectGoogle() {
    try {
      const r = await api<{ url: string }>("/api/connections/google/start", { method: "POST" });
      window.location.href = r.url;
    } catch (e) { setFlash({ tone: "bad", text: (e as Error).message }); }
  }

  const byId = new Map(data?.integrations.map((i) => [i.id, i]));
  const mcp = data?.integrations.filter((i) => i.kind === "mcp") ?? [];

  return (
    <>
      <PageHeader title="Connections" subtitle="Apps your assistant can use. An app only counts as connected after a live test passes." />
      {flash && <Notice tone={flash.tone}>{flash.text}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      <Notice>Your claude.ai connectors don't carry over to this app. Each service is authorized directly for your assistant, once, and the tokens are encrypted on the server.</Notice>

      {!data ? <Skeleton className="h-72" /> : (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            {data.options.filter((o) => o.availability !== "unavailable" && o.id !== "mcp").map((o) => {
              const rec = byId.get(o.id);
              return (
                <Card key={o.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[15px] font-semibold">{o.name}</div>
                      <div className="mt-0.5 text-[13px] text-muted">{o.covers}</div>
                    </div>
                    {o.availability === "builtin" ? <Badge tone="ok">Built in</Badge> : rec ? <Badge tone={statusTone(rec.status)}>{statusLabel(rec.status)}</Badge> : <Badge>Not connected</Badge>}
                  </div>
                  <div className="mt-3 text-[12.5px] text-muted">Authorization: {o.auth}</div>
                  {rec?.config.account ? <div className="mt-1 text-[12.5px] text-muted">Account: {String(rec.config.account)}</div> : null}
                  {rec?.config.shopDomain ? <div className="mt-1 text-[12.5px] text-muted">Store: {String(rec.config.shopDomain)}</div> : null}
                  {o.availability === "available" && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {o.id === "google" && (data.googleConfigured
                        ? <Button onClick={connectGoogle}>{rec ? "Reconnect Google" : "Connect Google"}</Button>
                        : <span className="text-[13px] text-warn">Add the Google OAuth client to the server first (docs/SETUP.md).</span>)}
                      {o.id === "shopify" && <Button onClick={() => setAdding("shopify")}>{rec ? "Replace token" : "Connect Shopify"}</Button>}
                    </div>
                  )}
                  {rec && <IntegrationControls rec={rec} onChange={reload} onFlash={setFlash} />}
                </Card>
              );
            })}
          </div>

          <Card title="Remote MCP servers" action={<Button variant="secondary" onClick={() => setAdding("mcp")}>Add server</Button>}>
            <p className="mb-4 text-[13.5px] text-muted">Add any service that has a remote MCP server by pasting its URL. Its tools are discovered automatically. You don't need to rebuild anything.</p>
            {mcp.length === 0 ? <Empty title="No MCP servers yet">Paste a server URL from the app's developer or MCP docs.</Empty> : (
              <div className="space-y-4">
                {mcp.map((rec) => (
                  <div key={rec.id} className="rounded-xl border border-line p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div><div className="text-[14.5px] font-semibold">{rec.displayName}</div><div className="text-[12.5px] text-muted break-all">{String(rec.config.url)}</div></div>
                      <Badge tone={statusTone(rec.status)}>{statusLabel(rec.status)}</Badge>
                    </div>
                    <IntegrationControls rec={rec} onChange={reload} onFlash={setFlash} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Not available to a cloud assistant">
            <ul className="space-y-3">
              {data.options.filter((o) => o.availability === "unavailable").map((o) => (
                <li key={o.id} className="flex items-start justify-between gap-4">
                  <div><div className="text-[14px] font-medium">{o.name}</div><div className="text-[13px] text-muted">{o.reason}</div></div>
                  <Badge>Unavailable</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {adding === "shopify" && <ShopifyDialog onClose={() => setAdding(null)} onDone={(t) => { setAdding(null); setFlash(t); void reload(); }} />}
      {adding === "mcp" && <McpDialog onClose={() => setAdding(null)} onDone={(t) => { setAdding(null); setFlash(t); void reload(); }} />}
    </>
  );
}

function IntegrationControls({ rec, onChange, onFlash }: { rec: Integration; onChange: () => void; onFlash: (f: { tone: "ok" | "bad"; text: string }) => void }) {
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [open, setOpen] = useState(false);

  async function test() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; detail: string }>(`/api/connections/${encodeURIComponent(rec.id)}/test`, { method: "POST" });
      onFlash({ tone: r.ok ? "ok" : "bad", text: `${rec.displayName}: ${r.detail}` });
      onChange();
    } catch (e) { onFlash({ tone: "bad", text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function toggle() {
    await api(`/api/connections/${encodeURIComponent(rec.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !rec.enabled }) });
    onChange();
  }
  async function remove() {
    if (!confirm(`Disconnect ${rec.displayName}? Its stored credentials will be deleted.`)) return;
    await api(`/api/connections/${encodeURIComponent(rec.id)}`, { method: "DELETE" });
    onChange();
  }
  async function loadTools() {
    setOpen(!open);
    if (tools || open) return;
    try { setTools(await api<Tool[]>(`/api/connections/${encodeURIComponent(rec.id)}/tools`)); } catch (e) { onFlash({ tone: "bad", text: (e as Error).message }); setOpen(false); }
  }
  async function setPolicy(name: string, policy: string) {
    await api(`/api/connections/${encodeURIComponent(rec.id)}`, { method: "PATCH", body: JSON.stringify({ toolPolicies: { [name]: policy } }) });
    setTools((t) => t?.map((x) => (x.name === name ? { ...x, policy: policy === "default" ? null : (policy as Tool["policy"]) } : x)) ?? null);
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted">
        <span>{rec.toolCount} tools</span>
        <span>Tested {fmtDate(rec.lastTestedAt)}</span>
        {!rec.enabled && <Badge>Paused</Badge>}
      </div>
      {rec.lastError && <div className="mt-2 text-[12.5px] text-bad">{rec.lastError}</div>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button variant="secondary" disabled={busy} onClick={test}>{busy ? "Testing…" : "Test now"}</Button>
        <Button variant="ghost" onClick={loadTools}>{open ? "Hide permissions" : "Tool permissions"}</Button>
        <Button variant="ghost" onClick={toggle}>{rec.enabled ? "Pause" : "Resume"}</Button>
        <Button variant="danger" onClick={remove}>Disconnect</Button>
      </div>
      {open && (
        <div className="mt-3 max-h-80 space-y-1 overflow-y-auto rounded-lg bg-surface-2 p-2">
          {!tools ? <Skeleton className="h-16" /> : tools.map((t) => (
            <div key={t.name} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-[12.5px]">{t.name}</div>
                <div className="truncate text-[12px] text-muted">{t.description}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={riskTone(t.defaultRisk)}>{riskLabel(t.defaultRisk)}</Badge>
                {t.defaultRisk !== "blocked" && (
                  <Select value={t.policy ?? "default"} onChange={(v) => setPolicy(t.name, v)}
                    options={[{ value: "default", label: "Default" }, { value: "auto", label: "Allow" }, { value: "confirm", label: "Always ask" }, { value: "block", label: "Block" }]} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="card fade-in w-full max-w-[460px] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h3 className="text-[17px] font-semibold">{title}</h3><button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

function ShopifyDialog({ onClose, onDone }: { onClose: () => void; onDone: (f: { tone: "ok" | "bad"; text: string }) => void }) {
  const [shopDomain, setShop] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ ok: boolean; detail: string }>("/api/connections/shopify", { method: "POST", body: JSON.stringify({ shopDomain, token }) });
      onDone({ tone: r.ok ? "ok" : "bad", text: `Shopify: ${r.detail}` });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog title="Connect Shopify" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[13px] text-muted">In Shopify admin: Settings → Apps → Develop apps → Create an app, give it read access to orders and products (plus write if you want changes), install it, then copy the Admin API access token.</p>
        <Field label="Store domain"><Input required placeholder="your-store.myshopify.com" value={shopDomain} onChange={(e) => setShop(e.target.value.trim())} /></Field>
        <Field label="Admin API access token" hint="Sent once to your server, encrypted, never shown again."><Input required type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value.trim())} /></Field>
        {err && <p className="text-[13px] text-bad">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy}>{busy ? "Testing…" : "Connect and test"}</Button></div>
      </form>
    </Dialog>
  );
}

function McpDialog({ onClose, onDone }: { onClose: () => void; onDone: (f: { tone: "ok" | "bad"; text: string }) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuth] = useState<"oauth" | "token" | "none">("oauth");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string; authorizeUrl?: string; test?: { ok: boolean; detail: string } }>("/api/connections/mcp", { method: "POST", body: JSON.stringify({ name, url, authMode, ...(authMode === "token" ? { token } : {}) }) });
      if (r.authorizeUrl) { window.location.href = r.authorizeUrl; return; }
      onDone({ tone: r.test?.ok ? "ok" : "bad", text: `${name}: ${r.test?.detail ?? "added"}` });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog title="Add an MCP server" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required placeholder="My service" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Server URL" hint="The remote (Streamable HTTP) MCP endpoint. Must be https."><Input required type="url" placeholder="https://…/mcp" value={url} onChange={(e) => setUrl(e.target.value.trim())} /></Field>
        <Field label="Sign-in">
          <Select value={authMode} onChange={(v) => setAuth(v as typeof authMode)} options={[{ value: "oauth", label: "Sign in with the service (OAuth)" }, { value: "token", label: "API token" }, { value: "none", label: "No sign-in" }]} />
        </Field>
        {authMode === "token" && <Field label="API token"><Input required type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value.trim())} /></Field>}
        {err && <p className="text-[13px] text-bad">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy}>{busy ? "Connecting…" : authMode === "oauth" ? "Continue to sign in" : "Add and test"}</Button></div>
      </form>
    </Dialog>
  );
}
