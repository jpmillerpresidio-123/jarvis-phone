# Setup and deployment

The code is finished and tested. What's left needs **your** accounts and sign-ins. Follow these in order. Each step says what it costs.

**Start Twilio's ID check first (step 5.1).** Twilio has to approve a compliance profile before you can buy a number, and that can take 1–2 days. Do everything else while you wait.

**Keep your keys in one private file.** Run `cp .env.example .env.railway` (it's gitignored). The helper scripts in `scripts/` fill it in with hidden typing and copy the whole file to your clipboard, ready to paste into Railway's **Variables → Raw Editor**. Never commit it.

> Nothing here upgrades a plan automatically. Expected running cost is about **$7/month fixed** (Railway Hobby ~$5 + Twilio number $1.15), plus usage: about **$0.08/minute** of calls (Twilio) and Claude tokens (typically a few cents per call).

---

## 1. Supabase: database and sign-in (free tier)

1. Create a project at <https://supabase.com/dashboard> (Free plan).
2. **SQL Editor** → paste the contents of `supabase/migrations/20261117000000_init.sql` → **Run**. Then do the same with `20261118000000_grants.sql`. New Supabase projects don't give the server's key access to tables automatically, and without this the backend fails with "permission denied".
3. **Authentication → URL Configuration**: set *Site URL* to your Vercel URL (step 4). Add `http://localhost:3000` to redirect URLs for local use.
4. **Authentication → Providers → Email**: leave enabled (magic links). Optional: turn off "Allow new users to sign up" after you've signed in once.
   Sign-in links only work in the **same browser** that asked for them. Request the link and open the email in the same browser.
5. **Project Settings → API**: copy the *Project URL*, the *anon* key (for Vercel) and the *service_role* key (Railway only. Never put it in the dashboard).

⚠️ Free projects pause after about a week with no activity. Regular calls keep it awake. If it pauses, click **Restore** in Supabase, or upgrade to Pro ($25/mo) if you want zero risk. Don't upgrade until you've decided.

## 2. Claude API key (pay as you go)

<https://console.anthropic.com> → **API keys** → create a key. Your claude.ai subscription and connectors are separate and aren't used.

## 3. Railway: backend (Hobby plan, about $5/mo, always on)

1. Fork or copy this repo to your own GitHub account. <https://railway.com> → **New project → Deploy from GitHub repo** → pick it. If Railway creates a second service for the dashboard, delete that one: the dashboard goes on Vercel.
2. Railway reads `railway.json` (build, start, `/health` check).
3. **Variables**: add everything under "Backend" in `.env.example` (`bash scripts/fill-railway-env.sh` helps). Generate `ENCRYPTION_KEY` with `openssl rand -base64 32`. Keep a copy somewhere safe, because changing it later makes stored tokens unreadable.
4. **Settings → Networking → Generate domain**. Put that URL in `PUBLIC_BASE_URL`.
5. Open `https://<your-domain>/health`. It should return `{"ok":true,…}`.

> The free trial sleeps or expires, and a sleeping server can't answer calls. Use Hobby for an always-on phone line.

## 4. Vercel: dashboard (Hobby, free)

1. <https://vercel.com/new> → import the same repo → **Root directory: `apps/dashboard`**.
2. Environment variables: `NEXT_PUBLIC_API_URL` (Railway URL), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Deploy, then set Railway's `DASHBOARD_ORIGIN` to the Vercel URL and redeploy the backend.
4. Visit the dashboard and sign in with `OWNER_EMAIL`.

## 5. Twilio: the phone number (about $1.15/mo + per-minute)

1. <https://console.twilio.com> → sign up, then **upgrade from trial**. A trial account plays a "trial account" message on every call. The smallest top-up (about $20) lasts months.
2. **Trust Hub → Profiles → Create your primary compliance profile → Individual.** It needs your name, address, a photo of a government ID and a selfie. Twilio usually approves it within 1–2 days, and you can't buy a number until it does. (If you don't have an ID, an adult who does can complete it as the account holder.)
3. **Phone Numbers → Buy a number** (a local US number; only **Voice** is needed). *This is a purchase, so you click it.* You can skip the "Voice registration" step afterwards; it's for outbound calls.
4. Open the number → **Configuration details → Voice and emergency address → Edit**. Primary method: **Use Webhooks**, URL `https://<railway-domain>/voice`, **HTTP POST**. Leave the backup URL empty.
5. Enable **ConversationRelay** if Twilio asks you to accept its AI/ML addendum (Console → Voice → Settings).
6. `bash scripts/add-twilio.sh` saves `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Console home page) and the **new Twilio number** (not your cell). Put your own mobile number in `ALLOWED_CALLERS`: only numbers listed there can talk to the assistant. Paste into Railway.

**Call the number.** You should hear the greeting. Ask "what can you do?"

## 6. Google (Gmail, Calendar, Drive, Docs, Sheets, Contacts) (free)

1. <https://console.cloud.google.com> → create a project, for example "Personal Assistant".
2. **APIs & Services → Library**: enable *Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API, People API*.
3. **Google Auth Platform (OAuth consent screen)**: app name "Personal Assistant", your email as support and contact.
   - **Personal Gmail:** audience **External**, add yourself under **Audience → Test users**, then **Publish app**. In "Testing" status Google expires sign-ins after 7 days. Published-but-unverified apps show an "unverified app" warning (click **Advanced → Go to …**), which is fine for personal use.
   - **School or work Google account:** choose **Internal**. No review, no 7-day expiry, no warning. Your organization's admins can still block outside apps; if connecting shows "Access blocked", use a personal Gmail instead.
4. **Clients → Create client → Web application**. Authorized redirect URI: `https://<railway-domain>/oauth/google/callback`.
5. **Copy the client secret right away.** Google shows it once; after that you can only add a new one. `bash scripts/add-google.sh` saves both (it also catches a secret pasted twice by accident). Paste into Railway.
6. Dashboard → **Connections → Connect Google**. It runs a live test (Gmail, Calendar and Drive) before showing *Connected*.

## 7. Shopify (optional, free)

Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app** → Admin API scopes `read_orders`, `read_products` (add `write_products` and similar only if you want changes) → **Install** → copy the Admin API token → Dashboard → **Connect Shopify**.

## 8. Any MCP server (optional)

Dashboard → **Connections → Add server**: name, the service's **remote MCP URL** (from its docs), and sign-in type. OAuth servers send you to their sign-in page and back. Tools are discovered automatically. Actions that spend credits ask for your confirmation, and credit purchases are always blocked.

## 9. Blackbaud homework (optional, free)

1. In your school's myschoolapp portal, open **Assignment Center** and find the calendar **subscribe / iCal feed** link (it starts with `webcal://`). It works like a password: don't share it.
2. `bash scripts/add-blackbaud.sh` saves it as `BLACKBAUD_ICAL` and checks it returns a calendar. Paste into Railway.
3. Ask "What homework do I have?" or "What classes do I have tomorrow?". The feed doesn't know what you've turned in, so the assistant says "if you haven't already" for past-due items.

## 10. Make it yours

Dashboard → **My Assistant**: its name and greeting, your name, your favorite teams (for scores and the "I'm home" rundown), voice and web search. For a British voice, set Voice ID to `Fahco4VZzobUeiPqni1S` (ElevenLabs).

---

## Local development

```bash
cp .env.example .env    # fill in what you have; leave SKIP_TWILIO_SIGNATURE unset in production
npm install
npm test
npm run dev:backend
NEXT_PUBLIC_DEV_TOKEN=dev-local npm run dev:dashboard
```

To test real calls against a local backend, expose port 8080 with a tunnel and point the Twilio webhook at it temporarily.

## Troubleshooting

| Symptom | Check |
|---|---|
| Call says "this line isn't available" | Your number isn't in `ALLOWED_CALLERS` (E.164 format, such as `+15551234567`) |
| Call drops right away | Railway logs → look for "bad Twilio signature": `PUBLIC_BASE_URL` must exactly match the webhook URL |
| "isn't fully set up yet" | `ANTHROPIC_API_KEY` missing |
| Dashboard "This dashboard belongs to someone else" | You signed in with an email other than `OWNER_EMAIL` |
| Google shows *Needs auth* after a week | The OAuth app is still in Testing. Publish it (step 6.3) and reconnect |
| Health check fails on deploy | Railway → Deploy logs. Usually a malformed variable; the error names it |
| Backend logs say "permission denied" (42501) | Run `supabase/migrations/20261118000000_grants.sql` in the SQL Editor |
| Sign-in link opens but nothing happens | Request the link in the same browser you open the email in |
| Google says `invalid_client` | The client secret is wrong (often pasted twice). Re-run `scripts/add-google.sh` |
| Vercel says "Deployment Blocked … commit author email is not valid" | Set this repo's git email to your GitHub one: `git config user.email "<id>+<user>@users.noreply.github.com"`, then push a change under `apps/dashboard` |
| Twilio won't sell you a number | Your compliance profile isn't approved yet (step 5.2) |
