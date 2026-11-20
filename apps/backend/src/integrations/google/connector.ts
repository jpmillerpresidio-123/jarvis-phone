import type { Connector, ToolDescriptor, ToolResult } from "../types.js";
import { textResult } from "../types.js";
import { refreshAccessToken, type GoogleTokens } from "./oauth.js";

type Input = Record<string, unknown>;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

function b64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64url");
}
function header(headers: { name: string; value: string }[] | undefined, name: string) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function extractText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  if (payload.parts) {
    const plain = payload.parts.map(extractText).filter(Boolean);
    if (plain.length) return plain.join("\n");
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  }
  return "";
}
function rfc2822(to: string, subject: string, body: string, cc?: string, inReplyTo?: string) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    inReplyTo ? `References: ${inReplyTo}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].filter((l, i, a) => l !== "" || i === a.length - 2);
  return b64url(lines.join("\r\n"));
}

export class GoogleConnector implements Connector {
  id = "google";
  displayName = "Google Workspace";
  private tokens: GoogleTokens;

  constructor(
    private clientId: string,
    private clientSecret: string,
    tokens: GoogleTokens,
    private onTokens: (t: GoogleTokens) => Promise<void>,
    private fetcher: typeof fetch = fetch,
  ) {
    this.tokens = tokens;
  }

  private async accessToken(): Promise<string> {
    if (this.tokens.access_token && (this.tokens.expires_at ?? 0) > Date.now() + 60_000) return this.tokens.access_token;
    const r = await refreshAccessToken(this.clientId, this.clientSecret, this.tokens.refresh_token);
    this.tokens = { ...this.tokens, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
    await this.onTokens(this.tokens);
    return r.access_token;
  }

  private async api(url: string, init: RequestInit = {}): Promise<any> {
    const token = await this.accessToken();
    const res = await this.fetcher(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* keep raw */ }
      throw new Error(`Google API ${res.status}: ${msg}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        name: "gmail__search", core: true, risk: "read",
        description: "Search the owner's Gmail with Gmail search syntax (e.g. 'from:alex newer_than:7d', 'is:unread'). Returns id, from, subject, date, snippet.",
        inputSchema: obj({ query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
      },
      {
        name: "gmail__read", core: true, risk: "read",
        description: "Read one Gmail message in full by id (from gmail__search).",
        inputSchema: obj({ message_id: { type: "string" } }, ["message_id"]),
      },
      {
        name: "gmail__create_draft", core: true, risk: "write",
        description: "Create a Gmail draft (does NOT send). Use for 'draft an email'.",
        inputSchema: obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, reply_to_message_id: { type: "string" } }, ["to", "subject", "body"]),
        describe: (i) => `create a draft to ${str(i.to)} with subject "${str(i.subject)}"`,
      },
      {
        name: "gmail__send", core: true, risk: "consequential",
        description: "Send an email immediately. Always requires the caller's confirmation.",
        inputSchema: obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, reply_to_message_id: { type: "string" } }, ["to", "subject", "body"]),
        describe: (i) => `send an email to ${str(i.to)} with subject "${str(i.subject)}"`,
      },
      {
        name: "gmail__send_draft", risk: "consequential",
        description: "Send an existing Gmail draft by draft id.",
        inputSchema: obj({ draft_id: { type: "string" } }, ["draft_id"]),
        describe: (i) => `send draft ${str(i.draft_id)}`,
      },
      {
        name: "gmail__trash", risk: "consequential",
        description: "Move a Gmail message to Trash (recoverable for 30 days).",
        inputSchema: obj({ message_id: { type: "string" } }, ["message_id"]),
        describe: (i) => `move message ${str(i.message_id)} to the trash`,
      },
      {
        name: "calendar__list_events", core: true, risk: "read",
        description: "List events on the owner's primary Google Calendar between two ISO-8601 datetimes (with timezone offset). Optional free-text query.",
        inputSchema: obj({ time_min: { type: "string" }, time_max: { type: "string" }, query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 50 } }, ["time_min", "time_max"]),
      },
      {
        name: "calendar__create_event", core: true,
        risk: (i) => (Array.isArray(i.attendees) && i.attendees.length ? "consequential" : "write"),
        description: "Create an event on the primary calendar. Adding attendees emails them an invitation, which requires confirmation.",
        inputSchema: obj({
          summary: { type: "string" }, start: { type: "string", description: "ISO-8601 with offset" }, end: { type: "string" },
          location: { type: "string" }, description: { type: "string" }, attendees: { type: "array", items: { type: "string" } },
        }, ["summary", "start", "end"]),
        describe: (i) => `create "${str(i.summary)}" from ${str(i.start)} to ${str(i.end)}${Array.isArray(i.attendees) && i.attendees.length ? ` and invite ${i.attendees.join(", ")}` : ""}`,
      },
      {
        name: "calendar__update_event", risk: "consequential",
        description: "Change an existing calendar event (title, time, location, description). Attendees are notified.",
        inputSchema: obj({ event_id: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" }, description: { type: "string" } }, ["event_id"]),
        describe: (i) => `update event ${str(i.event_id)}`,
      },
      {
        name: "calendar__delete_event", risk: "consequential",
        description: "Delete a calendar event.",
        inputSchema: obj({ event_id: { type: "string" } }, ["event_id"]),
        describe: (i) => `delete event ${str(i.event_id)}`,
      },
      {
        name: "drive__search", core: true, risk: "read",
        description: "Search Google Drive by name or full text. Returns id, name, type, modified time.",
        inputSchema: obj({ text: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 20 } }, ["text"]),
      },
      {
        name: "drive__read_file", core: true, risk: "read",
        description: "Read a Drive file's text (Google Docs as text, Sheets as CSV, Slides as text, plain text files).",
        inputSchema: obj({ file_id: { type: "string" } }, ["file_id"]),
      },
      {
        name: "docs__create", risk: "write",
        description: "Create a new Google Doc with the given title and plain-text content.",
        inputSchema: obj({ title: { type: "string" }, content: { type: "string" } }, ["title"]),
        describe: (i) => `create a Google Doc titled "${str(i.title)}"`,
      },
      {
        name: "docs__append", risk: "write",
        description: "Append plain text to the end of an existing Google Doc.",
        inputSchema: obj({ document_id: { type: "string" }, text: { type: "string" } }, ["document_id", "text"]),
        describe: (i) => `add text to document ${str(i.document_id)}`,
      },
      {
        name: "sheets__read", risk: "read",
        description: "Read values from a Google Sheet range in A1 notation (e.g. 'Sheet1!A1:D20').",
        inputSchema: obj({ spreadsheet_id: { type: "string" }, range: { type: "string" } }, ["spreadsheet_id", "range"]),
      },
      {
        name: "sheets__append_rows", risk: "write",
        description: "Append rows to a Google Sheet range.",
        inputSchema: obj({ spreadsheet_id: { type: "string" }, range: { type: "string" }, rows: { type: "array", items: { type: "array", items: { type: "string" } } } }, ["spreadsheet_id", "range", "rows"]),
        describe: (i) => `add ${Array.isArray(i.rows) ? i.rows.length : 0} rows to a spreadsheet`,
      },
      {
        name: "contacts__search", core: true, risk: "read",
        description: "Look up the owner's Google Contacts by name to find an email address or phone number.",
        inputSchema: obj({ query: { type: "string" } }, ["query"]),
      },
    ];
  }

  async callTool(name: string, i: Input): Promise<ToolResult> {
    const G = "https://gmail.googleapis.com/gmail/v1/users/me";
    const C = "https://www.googleapis.com/calendar/v3/calendars/primary";
    switch (name) {
      case "gmail__search": {
        const list = await this.api(`${G}/messages?${new URLSearchParams({ q: str(i.query), maxResults: String(num(i.max_results, 8)) })}`);
        const ids: { id: string }[] = list.messages ?? [];
        const rows = await Promise.all(ids.map(async ({ id }) => {
          const m = await this.api(`${G}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          return { id, from: header(m.payload?.headers, "From"), subject: header(m.payload?.headers, "Subject"), date: header(m.payload?.headers, "Date"), snippet: m.snippet, unread: (m.labelIds ?? []).includes("UNREAD") };
        }));
        return textResult(true, rows.length ? rows : "No matching emails.");
      }
      case "gmail__read": {
        const m = await this.api(`${G}/messages/${encodeURIComponent(str(i.message_id))}?format=full`);
        const h = m.payload?.headers;
        return textResult(true, {
          id: m.id, threadId: m.threadId, messageIdHeader: header(h, "Message-ID"),
          from: header(h, "From"), to: header(h, "To"), cc: header(h, "Cc"), subject: header(h, "Subject"), date: header(h, "Date"),
          body: extractText(m.payload).slice(0, 8000),
        });
      }
      case "gmail__create_draft":
      case "gmail__send": {
        let threadId: string | undefined;
        let inReplyTo: string | undefined;
        if (i.reply_to_message_id) {
          const orig = await this.api(`${G}/messages/${encodeURIComponent(str(i.reply_to_message_id))}?format=metadata&metadataHeaders=Message-ID`);
          threadId = orig.threadId;
          inReplyTo = header(orig.payload?.headers, "Message-ID") || undefined;
        }
        const raw = rfc2822(str(i.to), str(i.subject), str(i.body), str(i.cc) || undefined, inReplyTo);
        if (name === "gmail__create_draft") {
          const d = await this.api(`${G}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) });
          return textResult(Boolean(d.id), `Draft created (draft id ${d.id}). Not sent.`, `draft:${d.id}`);
        }
        const s = await this.api(`${G}/messages/send`, { method: "POST", body: JSON.stringify({ raw, threadId }) });
        const ok = Boolean(s.id) && (s.labelIds ?? []).includes("SENT");
        return textResult(ok, ok ? `Sent. Gmail message id ${s.id}.` : `Gmail did not confirm the send: ${JSON.stringify(s)}`, `message:${s.id}`);
      }
      case "gmail__send_draft": {
        const s = await this.api(`${G}/drafts/send`, { method: "POST", body: JSON.stringify({ id: str(i.draft_id) }) });
        const ok = Boolean(s.id) && (s.labelIds ?? []).includes("SENT");
        return textResult(ok, ok ? `Draft sent. Message id ${s.id}.` : `Send not confirmed: ${JSON.stringify(s)}`, `message:${s.id}`);
      }
      case "gmail__trash": {
        const t = await this.api(`${G}/messages/${encodeURIComponent(str(i.message_id))}/trash`, { method: "POST" });
        const ok = (t.labelIds ?? []).includes("TRASH");
        return textResult(ok, ok ? "Moved to Trash." : "Gmail did not confirm the message is in Trash.", `message:${t.id}`);
      }
      case "calendar__list_events": {
        const q = new URLSearchParams({ timeMin: str(i.time_min), timeMax: str(i.time_max), singleEvents: "true", orderBy: "startTime", maxResults: String(num(i.max_results, 25)) });
        if (i.query) q.set("q", str(i.query));
        const r = await this.api(`${C}/events?${q}`);
        const events = (r.items ?? []).map((e: any) => ({
          id: e.id, summary: e.summary, start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date,
          location: e.location, attendees: (e.attendees ?? []).map((a: any) => a.email).slice(0, 10), status: e.status,
        }));
        return textResult(true, events.length ? events : "No events in that range.");
      }
      case "calendar__create_event": {
        const attendees = Array.isArray(i.attendees) ? i.attendees.map((email) => ({ email: String(email) })) : undefined;
        const e = await this.api(`${C}/events?sendUpdates=${attendees?.length ? "all" : "none"}`, {
          method: "POST",
          body: JSON.stringify({ summary: str(i.summary), location: str(i.location) || undefined, description: str(i.description) || undefined, start: { dateTime: str(i.start) }, end: { dateTime: str(i.end) }, attendees }),
        });
        const verify = e.id ? await this.api(`${C}/events/${e.id}`) : null;
        const ok = Boolean(verify?.id);
        return textResult(ok, ok ? `Event created: "${verify.summary}" at ${verify.start?.dateTime}. id ${verify.id}` : "Calendar did not confirm the event.", `event:${e.id}`);
      }
      case "calendar__update_event": {
        const patch: Record<string, unknown> = {};
        if (i.summary) patch.summary = i.summary;
        if (i.location) patch.location = i.location;
        if (i.description) patch.description = i.description;
        if (i.start) patch.start = { dateTime: i.start };
        if (i.end) patch.end = { dateTime: i.end };
        const e = await this.api(`${C}/events/${encodeURIComponent(str(i.event_id))}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify(patch) });
        return textResult(Boolean(e.id), `Event updated: "${e.summary}" ${e.start?.dateTime ?? ""}`, `event:${e.id}`);
      }
      case "calendar__delete_event": {
        await this.api(`${C}/events/${encodeURIComponent(str(i.event_id))}?sendUpdates=all`, { method: "DELETE" });
        let gone = false;
        try { const e = await this.api(`${C}/events/${encodeURIComponent(str(i.event_id))}`); gone = e.status === "cancelled"; } catch { gone = true; }
        return textResult(gone, gone ? "Event deleted." : "Calendar still shows the event.", `event:${str(i.event_id)}`);
      }
      case "drive__search": {
        const t = str(i.text).replace(/['\\]/g, " ");
        const q = `(name contains '${t}' or fullText contains '${t}') and trashed = false`;
        const r = await this.api(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, pageSize: String(num(i.max_results, 10)), fields: "files(id,name,mimeType,modifiedTime,owners(displayName))", orderBy: "modifiedTime desc" })}`);
        return textResult(true, r.files?.length ? r.files : "No matching files.");
      }
      case "drive__read_file": {
        const id = encodeURIComponent(str(i.file_id));
        const meta = await this.api(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size`);
        const exportAs: Record<string, string> = {
          "application/vnd.google-apps.document": "text/plain",
          "application/vnd.google-apps.spreadsheet": "text/csv",
          "application/vnd.google-apps.presentation": "text/plain",
        };
        const token = await this.accessToken();
        const url = exportAs[meta.mimeType]
          ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs[meta.mimeType]!)}`
          : meta.mimeType?.startsWith("text/") || meta.mimeType === "application/json"
            ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media`
            : null;
        if (!url) return textResult(false, `"${meta.name}" is a ${meta.mimeType} file; I can only read Docs, Sheets, Slides and text files.`);
        const res = await this.fetcher(url, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
        return textResult(true, `File: ${meta.name}\n\n${(await res.text()).slice(0, 11000)}`);
      }
      case "docs__create": {
        const d = await this.api("https://docs.googleapis.com/v1/documents", { method: "POST", body: JSON.stringify({ title: str(i.title) }) });
        if (i.content) {
          await this.api(`https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: str(i.content) } }] }) });
        }
        return textResult(Boolean(d.documentId), `Created "${d.title}". Document id ${d.documentId}.`, `doc:${d.documentId}`);
      }
      case "docs__append": {
        const id = encodeURIComponent(str(i.document_id));
        const doc = await this.api(`https://docs.googleapis.com/v1/documents/${id}`);
        const end = (doc.body?.content?.at(-1)?.endIndex ?? 2) - 1;
        await this.api(`https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ insertText: { location: { index: Math.max(1, end) }, text: `\n${str(i.text)}` } }] }) });
        return textResult(true, `Appended to "${doc.title}".`, `doc:${doc.documentId}`);
      }
      case "sheets__read": {
        const r = await this.api(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(str(i.spreadsheet_id))}/values/${encodeURIComponent(str(i.range))}`);
        return textResult(true, r.values?.length ? r.values : "That range is empty.");
      }
      case "sheets__append_rows": {
        const r = await this.api(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(str(i.spreadsheet_id))}/values/${encodeURIComponent(str(i.range))}:append?valueInputOption=USER_ENTERED`, { method: "POST", body: JSON.stringify({ values: i.rows }) });
        const n = r.updates?.updatedRows ?? 0;
        return textResult(n > 0, `Added ${n} rows at ${r.updates?.updatedRange}.`, `sheet:${r.spreadsheetId}`);
      }
      case "contacts__search": {
        const r = await this.api(`https://people.googleapis.com/v1/people:searchContacts?${new URLSearchParams({ query: str(i.query), readMask: "names,emailAddresses,phoneNumbers", pageSize: "10" })}`);
        const people = (r.results ?? []).map((x: any) => ({
          name: x.person?.names?.[0]?.displayName, emails: (x.person?.emailAddresses ?? []).map((e: any) => e.value), phones: (x.person?.phoneNumbers ?? []).map((p: any) => p.value),
        }));
        return textResult(true, people.length ? people : "No matching contacts.");
      }
      default:
        return textResult(false, `Unknown Google tool ${name}`);
    }
  }

  async test() {
    const tools = await this.listTools();
    const checks: string[] = [];
    await this.api("https://gmail.googleapis.com/gmail/v1/users/me/profile").then((p) => checks.push(`Gmail ${p.emailAddress}`));
    await this.api("https://www.googleapis.com/calendar/v3/calendars/primary").then(() => checks.push("Calendar"));
    await this.api("https://www.googleapis.com/drive/v3/about?fields=user").then(() => checks.push("Drive"));
    return { ok: true, detail: `Verified: ${checks.join(", ")}`, toolCount: tools.length };
  }
}
