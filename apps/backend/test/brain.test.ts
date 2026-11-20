import { describe, expect, it } from "vitest";
import { BlackbaudConnector, parseIcal } from "../src/integrations/blackbaud.js";
import { SportsConnector, parseGame } from "../src/integrations/sports.js";
import { staticSystemPrompt } from "../src/agent/prompt.js";
import { claudeCostUsd } from "../src/agent/pricing.js";
import { DEFAULT_SETTINGS } from "../src/store/types.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261118",
  "DTEND;VALUE=DATE:20261121",
  "SUMMARY:Algebra II - 3: Unit 4 Test",
  "DESCRIPTION:Study sections 4.1\\, 4.2 and 4.3.<br>Bring a calculator\\n",
  " and a pencil.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261119T150000Z",
  "DTEND:20261120T075900Z",
  "SUMMARY:English 10: Read chapter 5",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTEND;VALUE=DATE:20261102",
  "SUMMARY:History: Essay on the New Deal",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Los_Angeles:20261119T095500",
  "DTEND;TZID=America/Los_Angeles:20261119T110000",
  "SUMMARY:Spanish I - B (B)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261119",
  "DTEND;VALUE=DATE:20261120",
  "SUMMARY:Week 2 Thursday (Example School)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTEND;VALUE=DATE:20261121",
  "SUMMARY:Spanish I - B: Evaluaci&#243;n oral&#160;",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("Blackbaud feed", () => {
  it("parses class, title, all-day due dates (exclusive end) and UTC times in the owner's zone", () => {
    const a = parseIcal(ICS, "America/Los_Angeles").filter((x) => x.isAssignment);
    expect(a.map((x) => [x.cls, x.title, x.dueDate, x.dueTime, x.kind])).toEqual([
      ["History", "Essay on the New Deal", "2026-11-01", null, "project"],
      ["English 10", "Read chapter 5", "2026-11-19", "11:59 PM", "homework"],
      ["Algebra II - 3", "Unit 4 Test", "2026-11-20", null, "test"],
      ["Spanish I - B", "Evaluación oral", "2026-11-20", null, "test"],
    ]);
    expect(a[2]!.details).toBe("Study sections 4.1, 4.2 and 4.3. Bring a calculator\nand a pencil.");
  });

  it("filters to the window, ranks tests highest and never leaks the feed link", async () => {
    const secret = "https://school.myschoolapp.com/podium/feed/iCal.aspx?z=SECRET";
    const fetcher = (async (url: string) => {
      expect(url).toBe(secret);
      return new Response(ICS, { status: 200 });
    }) as unknown as typeof fetch;
    const c = new BlackbaudConnector(secret, async () => "America/Los_Angeles", fetcher, () => new Date("2026-11-19T18:00:00Z"));
    const r = await c.callTool("school__assignments", {});
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain("SECRET");
    const body = JSON.parse(r.content) as { assignments: { title: string; priority: number | null; daysAway: number }[] };
    expect(body.assignments.map((x) => x.title)).toEqual(["Read chapter 5", "Unit 4 Test", "Evaluación oral"]); // essay is 18 days back; class meetings excluded
    const sched = JSON.parse((await c.callTool("school__schedule", {})).content);
    expect(sched).toEqual({ date: "2026-11-19", day: ["Week 2 Thursday (Example School)"], classes: [{ class: "Spanish I - B (B)", starts: "9:55 AM" }] });
    const test = body.assignments.find((x) => x.title === "Unit 4 Test")!;
    const hw = body.assignments.find((x) => x.title === "Read chapter 5")!;
    expect(test.daysAway).toBe(1);
    expect(test.priority).toBe(10);
    expect(hw.priority).toBe(6); // due today: 3 / 0.5
  });

  it("reports a failing feed without the link", async () => {
    const fetcher = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const c = new BlackbaudConnector("webcal://x.example/feed?token=SECRET", async () => "UTC", fetcher);
    await expect(c.test()).rejects.toThrow(/returned 403/);
    await expect(c.test()).rejects.not.toThrow(/SECRET/);
  });
});

const team = (id: string, abbr: string, display: string, nick: string, loc: string) =>
  ({ team: { id, abbreviation: abbr, displayName: display, shortDisplayName: nick, name: nick, nickname: nick, location: loc } });

function espnFetcher(now: Date) {
  const event = (id: string, date: string, state: string, completed: boolean, us: number, them: number) => ({
    id, date,
    competitions: [{
      status: { type: { state, completed, shortDetail: completed ? "Final" : state === "in" ? "Q3 5:12" : "7:00 PM" } },
      broadcasts: [{ media: { shortName: "NBCS-BA" } }],
      competitors: [
        { homeAway: "home", winner: completed ? us > them : undefined, score: { displayValue: String(us) }, team: { id: "9", displayName: "Golden State Warriors" } },
        { homeAway: "away", winner: completed ? them > us : undefined, score: { displayValue: String(them) }, team: { id: "13", displayName: "Los Angeles Lakers" } },
      ],
    }],
  });
  return (async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/basketball/nba/teams")) return json({ sports: [{ leagues: [{ teams: [team("9", "GS", "Golden State Warriors", "Warriors", "Golden State"), team("13", "LAL", "Los Angeles Lakers", "Lakers", "Los Angeles")] }] }] });
    if (url.endsWith("/teams")) return json({ sports: [{ leagues: [{ teams: [] }] }] });
    if (url.endsWith("/teams/9/schedule")) return json({ events: [
      event("1", "2026-11-15T03:00:00Z", "post", true, 112, 104),
      event("2", new Date(now.getTime() - 3600_000).toISOString(), "pre", false, 0, 0), // schedule lags during the game
      event("3", "2026-11-25T03:00:00Z", "pre", false, 0, 0),
    ] });
    if (url.endsWith("/teams/9")) return json({ team: { record: { items: [{ summary: "10-4" }] } } });
    if (url.endsWith("/scoreboard")) return json({ events: [event("2", new Date(now.getTime() - 3600_000).toISOString(), "in", false, 71, 66)] });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Sports", () => {
  it("parses a finished game from our side", () => {
    const g = parseGame({ id: "5", date: "2026-11-15T03:00:00Z", competitions: [{ status: { type: { state: "post", completed: true } }, competitors: [
      { homeAway: "away", winner: false, score: "99", team: { id: "9", displayName: "Golden State Warriors" } },
      { homeAway: "home", winner: true, score: "101", team: { id: "1", displayName: "Boston Celtics" } },
    ] }] }, "9");
    expect(g).toMatchObject({ home: false, opponent: "Boston Celtics", us: "99", them: "101", won: false, final: true });
  });

  it("finds a team by nickname and overlays the live score from the scoreboard", async () => {
    const now = new Date("2026-11-19T04:00:00Z");
    const s = new SportsConnector(async () => "", espnFetcher(now), () => now);
    const r = await s.callTool("sports__team", { team: "the warriors" });
    const body = JSON.parse(r.content) as { teams: { team: string; record: string; lastGame: { result: string }; nextGame: { live?: string; tv?: string } }[] };
    expect(body.teams[0]).toMatchObject({ team: "Golden State Warriors", record: "10-4" });
    expect(body.teams[0]!.lastGame.result).toBe("Won 112-104");
    expect(body.teams[0]!.nextGame.live).toBe("71-66, Q3 5:12");
    expect(body.teams[0]!.nextGame.tv).toBe("NBCS-BA");
  });

  it("uses favorite teams when none is named, and says so when there are none", async () => {
    const now = new Date("2026-11-19T04:00:00Z");
    const fav = new SportsConnector(async () => "Warriors", espnFetcher(now), () => now);
    expect((await fav.callTool("sports__team", {})).content).toContain("Golden State Warriors");
    const none = new SportsConnector(async () => "", espnFetcher(now), () => now);
    const r = await none.callTool("sports__team", {});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/No favorite teams/);
  });
});

describe("Jarvis persona and web search", () => {
  it("uses the owner's name and keeps the safety rules", () => {
    const p = staticSystemPrompt({ ...DEFAULT_SETTINGS, assistantName: "Jarvis", ownerName: "Sam" });
    expect(p).toContain("You are Jarvis, Sam's personal assistant");
    expect(p).toContain("I'm home");
    expect(p).toContain("Never write homework answers");
    expect(p).toContain("CONFIRMATION_REQUIRED");
    expect(p).toContain("never make phone calls");
  });

  it("adds a cent per web search to the cost", () => {
    const base = { input_tokens: 0, output_tokens: 0 };
    expect(claudeCostUsd("claude-opus-5-5", { ...base, server_tool_use: { web_search_requests: 2 } })).toBeCloseTo(0.02);
  });
});
