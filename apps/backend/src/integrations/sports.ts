import type { Connector, ToolDescriptor, ToolResult } from "./types.js";
import { textResult } from "./types.js";

/**
 * Pro sports scores and schedules from ESPN's public site API (no key needed).
 * Ported from jarvis-brain tools/brief.py. Lessons kept from there: the team
 * schedule feed lags during a game (shows 0-0), so games near "now" take their
 * status and score from the live scoreboard, matched by event id.
 */
const LEAGUES = [
  ["basketball", "nba"], ["football", "nfl"], ["baseball", "mlb"], ["hockey", "nhl"],
  ["basketball", "wnba"], ["soccer", "usa.1"],
] as const;
const BASE = "https://site.api.espn.com/apis/site/v2/sports";

interface TeamRef { sport: string; league: string; id: string; abbr: string; name: string; words: string[] }
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Game {
  id: string; when: string; state: string; final: boolean; detail: string;
  home: boolean; opponent: string; tv: string; us: string | null; them: string | null; won: boolean | null;
}

const score = (c: Json): string | null => (c?.score && typeof c.score === "object" ? c.score.displayValue : c?.score) ?? null;

/** Pure: turns one ESPN event into a Game from our team's side. Exported for tests. */
export function parseGame(e: Json, teamId: string): Game | null {
  const c = e?.competitions?.[0];
  if (!c?.competitors?.length) return null;
  const us = c.competitors.find((x: Json) => String(x.team?.id) === teamId) ?? c.competitors[0];
  const them = c.competitors.find((x: Json) => x !== us) ?? us;
  const st = c.status?.type ?? e.status?.type ?? {};
  return {
    id: String(e.id), when: e.date, state: st.state ?? "pre", final: Boolean(st.completed), detail: st.shortDetail ?? st.detail ?? "",
    home: us.homeAway === "home", opponent: them.team?.displayName ?? "?",
    tv: (c.broadcasts ?? []).map((b: Json) => b.media?.shortName ?? (b.names ?? []).join("/")).filter(Boolean).slice(0, 2).join(", "),
    us: score(us), them: score(them), won: typeof us.winner === "boolean" ? us.winner : null,
  };
}

export class SportsConnector implements Connector {
  id = "sports";
  displayName = "Sports scores";
  private teams: TeamRef[] | null = null;
  private teamsAt = 0;
  constructor(private favorites: () => Promise<string>, private fetcher: typeof fetch = fetch, private now = () => new Date()) {}

  private async get(url: string): Promise<Json> {
    const res = await this.fetcher(url, { headers: { "user-agent": "jarvis/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    return res.json();
  }

  /** All pro teams in the leagues above, refreshed daily. */
  private async allTeams(): Promise<TeamRef[]> {
    if (this.teams && Date.now() - this.teamsAt < 86_400_000) return this.teams;
    const lists = await Promise.all(LEAGUES.map(async ([sport, league]) => {
      try {
        const d = await this.get(`${BASE}/${sport}/${league}/teams`);
        return (d.sports?.[0]?.leagues?.[0]?.teams ?? []).map(({ team: t }: Json) => ({
          sport, league, id: String(t.id), abbr: String(t.abbreviation ?? "").toLowerCase(), name: t.displayName,
          words: [t.displayName, t.shortDisplayName, t.name, t.nickname, t.location].filter(Boolean).map((w: string) => w.toLowerCase()),
        }));
      } catch { return []; }
    }));
    this.teams = lists.flat();
    this.teamsAt = Date.now();
    return this.teams;
  }

  async findTeams(query: string): Promise<TeamRef[]> {
    const q = query.toLowerCase().replace(/^the\s+/, "").trim();
    if (!q) return [];
    const teams = await this.allTeams();
    const exact = teams.filter((t) => t.words.includes(q) || t.abbr === q);
    if (exact.length) return exact;
    return teams.filter((t) => t.words.some((w) => w.includes(q) || (q.length > 3 && q.includes(w))));
  }

  private async report(t: TeamRef) {
    const [sched, info] = await Promise.all([
      this.get(`${BASE}/${t.sport}/${t.league}/teams/${t.id}/schedule`),
      this.get(`${BASE}/${t.sport}/${t.league}/teams/${t.id}`).catch(() => null),
    ]);
    const games = (sched.events ?? []).map((e: Json) => parseGame(e, t.id)).filter(Boolean) as Game[];
    const now = this.now().getTime();
    const near = games.filter((g) => !g.final && Math.abs(Date.parse(g.when) - now) < 5 * 3600_000);
    if (near.length) {
      try {
        const board = await this.get(`${BASE}/${t.sport}/${t.league}/scoreboard`);
        const byId = new Map<string, Json>((board.events ?? []).map((e: Json) => [String(e.id), e]));
        for (const g of near) {
          const live = byId.get(g.id) && parseGame(byId.get(g.id), t.id);
          if (live) Object.assign(g, { state: live.state, final: live.final, detail: live.detail, us: live.us, them: live.them, won: live.won, tv: live.tv || g.tv });
        }
      } catch { /* keep the schedule's data */ }
    }
    const done = games.filter((g) => g.final);
    const ahead = games.filter((g) => !g.final && Date.parse(g.when) > now - 5 * 3600_000);
    const fmt = (g: Game) => ({
      when: g.when, opponent: g.opponent, homeOrAway: g.home ? "home" : "away", tv: g.tv || undefined,
      ...(g.state === "in" ? { live: `${g.us}-${g.them}, ${g.detail}` } : {}),
      ...(g.final ? { result: `${g.won ? "Won" : g.won === false ? "Lost" : "Final"} ${g.us}-${g.them}` } : {}),
    });
    return {
      team: t.name, league: t.league.toUpperCase(),
      record: info?.team?.record?.items?.[0]?.summary ?? sched.team?.recordSummary ?? undefined,
      lastGame: done.length ? fmt(done[done.length - 1]!) : null,
      nextGame: ahead.length ? fmt(ahead[0]!) : null,
    };
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [{
      name: "sports__team", core: true, risk: "read",
      description: "Live pro sports facts from ESPN (NBA, NFL, MLB, NHL, WNBA, MLS): a team's last result, next game (time is ISO UTC; convert to the owner's time zone), TV channel, record, and the live score if a game is on. Leave team empty for the owner's favorite teams. Not for college teams: use web search for those.",
      inputSchema: { type: "object", properties: { team: { type: "string", description: "Team name or city, e.g. 'Warriors' or 'San Francisco'. Empty = favorite teams." } }, additionalProperties: false },
    }];
  }

  async callTool(name: string, i: Record<string, unknown>): Promise<ToolResult> {
    if (name !== "sports__team") return textResult(false, `Unknown tool ${name}`);
    const asked = String(i.team ?? "").trim();
    const queries = asked ? [asked] : (await this.favorites()).split(",").map((s) => s.trim()).filter(Boolean);
    if (!queries.length) return textResult(false, "No favorite teams are set. Ask which team they mean (and suggest adding favorites in the dashboard under My Assistant), or web-search it.");
    const found: TeamRef[] = [];
    const missing: string[] = [];
    for (const q of queries) {
      const m = await this.findTeams(q);
      if (!m.length) missing.push(q);
      else found.push(...(asked ? m.slice(0, 3) : m.slice(0, 1)));
    }
    const reports = await Promise.all(found.map((t) => this.report(t).catch((e) => ({ team: t.name, error: (e as Error).message }))));
    return textResult(reports.length > 0, {
      ...(reports.length > 1 && asked ? { note: "Several teams matched; pick the one they most likely mean." } : {}),
      teams: reports,
      ...(missing.length ? { notFound: missing, hint: "Not a pro team ESPN lists here; use web search." } : {}),
    });
  }

  async test() {
    const t = await this.findTeams("warriors");
    return { ok: t.length > 0, detail: t.length ? "ESPN reachable" : "ESPN team list unavailable", toolCount: 1 };
  }
}
