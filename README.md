# Jarvis Phone

A personal AI assistant you call from your own phone, built on Claude. It answers a dedicated Twilio number, talks naturally (you can interrupt it), remembers things between calls, and can answer almost anything:

- **General questions** straight from Claude, usually in about a second.
- **Anything current** (news, weather, prices, "who won") with live web search.
- **Pro sports**: scores, schedules, records and live scores from ESPN (NBA, NFL, MLB, NHL, WNBA, MLS).
- **Your stuff**: Gmail, Calendar, Drive, Docs, Sheets and Contacts once you connect Google, plus Shopify and any remote MCP server.
- **School**: Blackbaud (myschoolapp) homework, tests and class schedule from your assignment feed, ranked by what to do first.
- **"I'm home"**: a spoken rundown of unread email, the rest of today's calendar, today's games and the homework that matters most.

Its personality and rules come from [jarvis-brain](https://github.com/jpmillerpresidio-123/jarvis-brain), adapted for a phone call: it leads with the answer, keeps it short, and never writes homework answers for you to hand in.

It runs entirely in the cloud: the backend on **Railway**, the dashboard on **Vercel**, and the data in **Supabase**. Your Mac can be off.

```
 your phone ──► Twilio number ──► POST /voice (TwiML) ──► ConversationRelay
                                                             │  speech-to-text / text-to-speech
                                                             ▼
                                   wss://…/relay  ◄──►  Railway backend (Node + TypeScript)
                                                         ├─ Claude API (streaming, tool use)
                                                         ├─ permission gate (confirm / block)
                                                         ├─ tools: Google · Shopify · MCP · Memory · Sports · Blackbaud · web search
                                                         └─ Supabase (memory, calls, tasks, usage, audit)
                                                             ▲
                                   Vercel dashboard ─────────┘  (owner-only sign-in)
```

## What's here

| Path | What it is |
|---|---|
| `apps/backend` | Fastify server: Twilio webhooks, the ConversationRelay WebSocket, the Claude conversation engine, connectors, and the dashboard API |
| `apps/dashboard` | Next.js + Tailwind dashboard: Overview, My Assistant, Phone, Connections, Memory, Tasks, Call History, Usage & Costs, Settings |
| `supabase/migrations` | Database schema with owner-only row-level security |
| `docs/SETUP.md` | **Start here.** Step-by-step setup and deployment (about an hour, plus 1–2 days for Twilio's ID check) |
| `scripts/` | Helpers that save keys into `.env.railway` with hidden typing and copy them for Railway |
| `docs/ARCHITECTURE.md` | How it works, the reasoning behind the design, limitations |

## Quick start (local)

```bash
npm install
npm test                      # backend test suite
npm run dev:backend           # http://localhost:8080 (in-memory store if Supabase isn't configured)
NEXT_PUBLIC_DEV_TOKEN=dev-local npm run dev:dashboard   # http://localhost:3000
```

Without Supabase the backend keeps data in memory and accepts the `dev-local` token, but only outside production.

## Safety guarantees

- **Incoming calls only.** No code path places a call. Tools named like `create_call`, `dial` or `make_call` are hard-blocked, and the recommended Twilio key can't create calls.
- **No spending.** Purchases, payments, credit top-ups and plan upgrades are hard-blocked.
- **Confirmation before anything consequential.** Sending, replying, forwarding, deleting, sharing, publishing, inviting people and generating paid media need your spoken "yes" in a later turn.
- **Honest integrations.** An app shows as connected only after a live test passes. Failures are reported, never faked.
- **Secrets stay on the server.** OAuth tokens and API keys are AES-256-GCM encrypted in Supabase. The browser never receives them.
- **Prompt-injection guard.** Email, document and web content goes to Claude as untrusted data.

## Make it yours

- **Name, greeting, voice, your name and favorite teams:** dashboard → **My Assistant**. No code changes needed.
- **Personality and rules:** `apps/backend/src/agent/prompt.ts`. The safety rules at the end always apply.
- **New abilities:** add a connector in `apps/backend/src/integrations/` (see `sports.ts` for a small example), or connect a remote MCP server from the dashboard with no code at all.

## What it costs

About **$7/month fixed** (Railway Hobby about $5, Twilio number $1.15), plus about **8¢ per minute** of calls (Twilio) and Claude usage, typically a few cents per call. Web searches are about 1¢ each. Everything else here (Supabase free tier, Vercel Hobby, Google APIs, ESPN, Blackbaud feed) is free. The dashboard's **Usage & Costs** page tracks it.

## License

MIT. See `LICENSE`.
