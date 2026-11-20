import type { Connector, ToolDescriptor, ToolResult } from "./types.js";
import { textResult } from "./types.js";

/**
 * Blackbaud (myschoolapp) assignments from the student's iCal feed link.
 * Ported from jarvis-brain tools/assignments.py. The link works like a password,
 * so it lives only in the server env (BLACKBAUD_ICAL) and is never returned.
 * The feed has class, title, due date and instructions, but not whether an
 * assignment is finished.
 */
export interface Assignment {
  cls: string; title: string;
  /** Due date in the owner's time zone, YYYY-MM-DD. */
  dueDate: string;
  /** "h:mm AM" in the owner's time zone, or null for all-day items. */
  dueTime: string | null;
  details: string;
  kind: "test" | "project" | "homework";
  /** False for class meetings and day labels ("Physics 1 - G (G)", "Week 2 Monday"), which have no "Class: " prefix. */
  isAssignment: boolean;
  /** "HHMM" (24h) for ordering; empty for all-day items. */
  sortTime?: string;
}

const unescape = (s: string) => s
  .replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/\u00a0/g, " ");

function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute} ${p.dayPeriod}` };
}

function kindOf(title: string): Assignment["kind"] {
  // "Homework to help prepare for Quiz" is homework, not the quiz itself.
  if (/\b(hw|homework|prep|prepare|preparing|study for|review for|practice)\b/i.test(title)) return "homework";
  if (/\b(test|exam|quiz|midterm|final exam|assessment|evaluaci[oó]n)\b/i.test(title)) return "test";
  if (/\b(project|essay|paper|presentation|report|lab)\b/i.test(title)) return "project";
  return "homework";
}

/** Pure iCal parser. Exported for tests. */
export function parseIcal(text: string, tz: string): Assignment[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const out: Assignment[] = [];
  for (const m of unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
    const f: Record<string, { params: string; value: string }> = {};
    for (const line of m[1]!.trim().split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [key, ...params] = line.slice(0, i).split(";");
      f[key!.toUpperCase()] = { params: params.join(";"), value: line.slice(i + 1) };
    }
    const summary = unescape(f.SUMMARY?.value ?? "").trim();
    const sep = summary.indexOf(": ");
    const [cls, title] = sep > 0 ? [summary.slice(0, sep), summary.slice(sep + 2)] : ["", summary];
    // School-wide events ("Thanksgiving Break: Campus Closed (Example School)") aren't homework.
    const isAssignment = sep > 0 && !/\([^()]*\bschool\)\s*$/i.test(summary);
    // Assignments are due at their end; class meetings are listed by when they start.
    const raw = isAssignment ? (f.DTEND ?? f.DTSTART) : (f.DTSTART ?? f.DTEND);
    if (!raw) continue;
    const v = raw.value.trim();
    let dueDate: string, dueTime: string | null, sortTime = "";
    if (/^\d{8}$/.test(v)) {
      // All-day: iCal's DTEND is exclusive, so the real due date is the day before.
      const d = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)));
      if (raw === f.DTEND) d.setUTCDate(d.getUTCDate() - 1);
      dueDate = d.toISOString().slice(0, 10);
      dueTime = null;
    } else {
      const mm = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
      if (!mm) continue;
      const [, y, mo, da, h, mi, , z] = mm;
      let hr = +h!, min = mi!;
      if (z) {
        const lp = localParts(new Date(Date.UTC(+y!, +mo! - 1, +da!, +h!, +mi!)), tz);
        dueDate = lp.date;
        const [hh, rest] = lp.time.split(":");
        hr = (+hh! % 12) + (/PM/.test(rest!) ? 12 : 0);
        min = rest!.slice(0, 2);
      } else {
        // Floating or TZID time: already the school's wall-clock time.
        dueDate = `${y}-${mo}-${da}`;
      }
      dueTime = `${hr % 12 || 12}:${min} ${hr < 12 ? "AM" : "PM"}`;
      sortTime = `${String(hr).padStart(2, "0")}${min}`;
    }
    const details = unescape(f.DESCRIPTION?.value ?? "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    out.push({ cls: cls.trim(), title: title.trim(), dueDate, dueTime, details, kind: kindOf(title), isAssignment, sortTime });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.sortTime ?? "").localeCompare(b.sortTime ?? ""));
}

const WEIGHT = { test: 10, project: 6, homework: 3 } as const;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

export class BlackbaudConnector implements Connector {
  id = "blackbaud";
  displayName = "Blackbaud assignments";
  private cache: { at: number; text: string } | null = null;
  constructor(private feedUrl: string, private timezone: () => Promise<string>, private fetcher: typeof fetch = fetch, private now = () => new Date()) {}

  private async feed(): Promise<string> {
    if (this.cache && Date.now() - this.cache.at < 300_000) return this.cache.text;
    const url = this.feedUrl.trim().replace(/^webcal:\/\//i, "https://");
    const res = await this.fetcher(url, { headers: { "user-agent": "jarvis-assignments/1.0" }, signal: AbortSignal.timeout(15000) });
    // Never echo the URL: it works like a password.
    if (!res.ok) throw new Error(`The assignment feed returned ${res.status}`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("The assignment feed link didn't return a calendar");
    this.cache = { at: Date.now(), text };
    return text;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [{
      name: "school__assignments", core: true, risk: "read",
      description: "Blackbaud assignments from the school feed: class, title, due date and time, type (test/project/homework), a priority score (higher = do first), and a short version of the teacher's instructions. Doesn't know what's already finished. Use details_for to get the full instructions for matching titles.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 60, description: "Days ahead to include (default 14)" },
          past_days: { type: "integer", minimum: 0, maximum: 30, description: "Days back to include (default 3)" },
          class_name: { type: "string", description: "Only this class (any part of its name)" },
          details_for: { type: "string", description: "Words from a title: return full instructions for matching assignments" },
        },
        additionalProperties: false,
      },
    }, {
      name: "school__schedule", core: true, risk: "read",
      description: "Their class schedule from Blackbaud for one day: the rotation day label (e.g. 'Week 2 Monday') and each class meeting with its start time. Use for 'what classes do I have tomorrow' or 'when is Physics'.",
      inputSchema: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD in the owner's time zone (default today)" } },
        additionalProperties: false,
      },
    }];
  }

  async callTool(name: string, i: Record<string, unknown>): Promise<ToolResult> {
    const tz = await this.timezone();
    const today = localParts(this.now(), tz).date;
    if (name === "school__schedule") {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(i.date ?? "")) ? String(i.date) : today;
      const day = parseIcal(await this.feed(), tz).filter((a) => !a.isAssignment && a.dueDate === date);
      if (!day.length) return textResult(true, `Nothing on the school schedule for ${date} (likely a weekend or break).`);
      return textResult(true, {
        date,
        day: day.filter((a) => !a.dueTime).map((a) => (a.cls ? `${a.cls}: ${a.title}` : a.title)),
        classes: day.filter((a) => a.dueTime).map((a) => ({ class: a.title, starts: a.dueTime })),
      });
    }
    if (name !== "school__assignments") return textResult(false, `Unknown tool ${name}`);
    const days = typeof i.days === "number" ? i.days : 14;
    const past = typeof i.past_days === "number" ? i.past_days : 3;
    const cls = String(i.class_name ?? "").toLowerCase();
    const full = String(i.details_for ?? "").toLowerCase();
    const items = parseIcal(await this.feed(), tz).filter((a) => {
      if (!a.isAssignment) return false;
      const d = dayDiff(a.dueDate, today);
      return d >= -past && d <= days && a.cls.toLowerCase().includes(cls) && `${a.title} ${a.cls}`.toLowerCase().includes(full);
    });
    if (!items.length) return textResult(true, "No assignments in that window.");
    return textResult(true, {
      today,
      note: "The feed has no done/not-done status. For anything past due, say 'if you haven't already'.",
      assignments: items.map((a) => {
        const d = dayDiff(a.dueDate, today);
        return {
          class: a.cls || "No class", title: a.title, type: a.kind, due: a.dueDate, dueTime: a.dueTime ?? undefined,
          daysAway: d, ...(d < 0 ? { pastDue: true } : {}),
          priority: d < 0 ? null : Math.round((WEIGHT[a.kind] / Math.max(d, 0.5)) * 10) / 10,
          details: full ? a.details : a.details.slice(0, 160) + (a.details.length > 160 ? "…" : ""),
        };
      }),
    });
  }

  async test() {
    const n = parseIcal(await this.feed(), await this.timezone()).filter((a) => a.isAssignment).length;
    return { ok: true, detail: `Feed reachable, ${n} assignments in it`, toolCount: 2 };
  }
}
