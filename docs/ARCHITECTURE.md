# Architecture and decisions

## Call flow

1. Twilio receives a call and POSTs to `/voice`. The backend verifies `X-Twilio-Signature`, rejects non-inbound legs and callers not in `ALLOWED_CALLERS`, and returns TwiML with `<Connect><ConversationRelay>`. The TwiML carries a short-lived HMAC **call token** bound to the CallSid.
2. Twilio opens `wss://…/relay`. The first `setup` message must carry a valid call token for its CallSid and an allowed `from` number, or the socket is closed.
3. Each `prompt` (your finished sentence) runs one turn of the `CallSession` (`src/agent/engine.ts`). Claude's text streams back token by token as `{type:"text"}` messages, so speech starts before the answer is finished.
4. `interrupt` cancels the in-flight Claude stream. The half-spoken turn is discarded and the next turn tells Claude where it was cut off.
5. When the socket closes, the session waits 15 seconds for a reconnect (Twilio's `<Connect action>` callback re-opens the relay on failure, keeping context). Then it finalizes: duration, Twilio cost, and an AI summary. If auto-save is on, it also extracts durable memories.

## Claude usage

- `client.beta.messages.stream` with model `claude-opus-5-5` at `effort: low`, which keeps the phone responsive. Change `CLAUDE_MODEL` or `CLAUDE_EFFORT` to trade speed for depth.
- Server-side refusal fallbacks (`fallbacks: "default"`) are enabled, so a refusal on one model can be retried on another.
- Prompt caching: a stable system prompt and tool list are cached. Per-call context (time, memories, recent summaries) goes in a second system block.
- With more than 25 tools, non-core tools are marked `defer_loading` and Claude finds them with the BM25 tool-search tool. This is how an MCP server with 100+ tools stays usable on a phone call.

## Connectors

`Connector` (`src/integrations/types.ts`) is the only interface: `listTools`, `callTool`, `test`. Implementations:

| Connector | Auth | Notes |
|---|---|---|
| Google (`google/connector.ts`) | App's own OAuth client, offline refresh token | Gmail (search, read, draft, send, trash), Calendar (list, create, update, delete), Drive (search, read), Docs (create, append), Sheets (read, append), Contacts (search). Sends and deletes are verified after the fact (SENT label, TRASH label, event gone). |
| Shopify (`shopify.ts`) | Custom-app Admin API token | Summary, orders, products, read-only GraphQL. Mutations always need confirmation. |
| Remote MCP (`mcp.ts`) | MCP OAuth (dynamic client registration + PKCE) or bearer token | Tools discovered with `tools/list`. MCP annotations (`readOnlyHint`, `destructiveHint`) feed the permission gate. |
| Memory (`memoryTools.ts`) | Built in | remember / recall / forget. Refuses card numbers, passwords and similar. |

**Why the backend runs MCP itself instead of the Claude API's MCP connector:** with the API's `mcp_servers`, Anthropic executes the tool calls directly, so the app can't pause a "send" or "delete" to ask for your spoken confirmation. Running the MCP client in the backend keeps every call behind the permission gate.

**Why claude.ai connectors aren't reused:** they're authorized for claude.ai, and their tokens aren't available to other applications or the API. Each service is authorized once for this app instead, from the Connections page.

## Permission gate (`src/agent/gate.ts`)

In order of precedence:

1. **Hard block**: outbound calls, purchases, payments, credit top-ups. No setting can change these.
2. **Your per-tool policy** from the dashboard: Allow, Always ask, or Block.
3. **Connector-declared risk**, which can depend on the input (a calendar event with attendees sends invites, so it asks first).
4. **MCP annotations.**
5. **Name heuristics**: send/delete/share/publish ask first, create/update are logged writes, get/list/search are reads. **Unknown tools ask first.**

A consequential call returns `CONFIRMATION_REQUIRED action_id=…` instead of running. `confirm_action` runs it only if all of these hold:

- the caller has spoken since the request;
- their reply contains a clear yes and no "no", "wait" or "cancel";
- the request is under five minutes old;
- the PIN was entered, if `VOICE_PIN` is set.

Completed consequential actions are keyed by tool and input, so the same email isn't sent twice in one call.

## Data (Supabase)

Tables: `settings`, `memories` (full-text indexed), `calls`, `transcript_lines`, `tasks`, `usage_events`, `integrations` (encrypted `secret` column), `audit_log`, `app_owner`. RLS admits only the owner's verified email. Integrations are exposed only through a view without secrets. The backend uses the service-role key; the dashboard talks to the backend API, which checks the Supabase session token against `OWNER_EMAIL`.

## Limitations to know about

- **Caller ID can be spoofed.** The allow-list keeps strangers out; spoken confirmation still guards sending, deleting and sharing. A keypad PIN (`VOICE_PIN`) is supported but off.
- **One backend instance.** Live sessions are in memory. A deploy or restart mid-call drops that call (Twilio's reconnect retries once). Keep `numReplicas: 1`.
- **Supabase Free pauses** after about a week idle. See SETUP.md.
- **Google "Testing" mode** expires tokens after 7 days. Publish the OAuth app.
- **Costs are estimates** from list prices in `src/agent/pricing.ts`; Twilio and Anthropic invoices are authoritative.
- **Other services** work only if they offer a remote MCP endpoint that accepts third-party sign-in. Each shows as connected only after its live test passes.
- **Blackbaud's feed** has no done/not-done status, and class meetings are told apart from assignments by the feed's "Class: Title" format.
- **Web search** uses the basic search tool because it answers about twice as fast on the phone as the filtering version.
