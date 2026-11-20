import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { allowedCallers } from "../config.js";
import { signCallToken, validTwilioSignature, verifyCallToken } from "../lib/crypto.js";
import { CallSession } from "../agent/engine.js";
import { summarizeCall } from "../agent/summarize.js";
import { twilioCostUsd } from "../agent/pricing.js";
import type { AppContext } from "../context.js";
import { RelayConnection, type RelayInbound } from "./relay.js";
import { hangup, relayTwiml, sayAndHangup } from "./twiml.js";

/** Sessions survive a dropped WebSocket for a few minutes so a reconnect keeps context. */
const sessions = new Map<string, { session: CallSession; startedAt: number; detachedAt: number | null }>();
setInterval(() => {
  for (const [sid, s] of sessions) if (s.detachedAt && Date.now() - s.detachedAt > 5 * 60_000) sessions.delete(sid);
}, 60_000).unref();

export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { cfg, store } = ctx;
  const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
  const wsBase = base.replace(/^http/, "ws");

  function twilioValid(req: FastifyRequest, url: string, params: Record<string, string> = {}) {
    if (cfg.SKIP_TWILIO_SIGNATURE) return true;
    if (!cfg.TWILIO_AUTH_TOKEN) return false;
    return validTwilioSignature(cfg.TWILIO_AUTH_TOKEN, req.headers["x-twilio-signature"] as string | undefined, [url], params);
  }

  function relayResponse(callSid: string, greeting: string | null) {
    const token = signCallToken(cfg.TWILIO_AUTH_TOKEN ?? cfg.ENCRYPTION_KEY ?? "dev", callSid);
    return store.getSettings().then((settings) =>
      relayTwiml({ wsUrl: `${wsBase}/relay`, actionUrl: `${base}/voice/connect-ended`, callToken: token, settings, greeting }));
  }

  // 1) Twilio calls this when someone dials the number.
  app.post("/voice", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    reply.type("text/xml");
    if (!twilioValid(req, `${base}/voice`, body)) {
      req.log.warn("Rejected /voice: bad Twilio signature");
      return reply.code(403).send(hangup());
    }
    if (body.Direction && body.Direction !== "inbound") return hangup(); // never handle outbound legs
    const from = body.From ?? "";
    const allowed = allowedCallers(cfg);
    if (!allowed.has(from)) {
      await store.audit({ actor: "system", action: "call_rejected", detail: { from, callSid: body.CallSid }, at: new Date().toISOString() }).catch(() => undefined);
      await store.createCall({ callSid: body.CallSid ?? `rejected-${Date.now()}`, fromNumber: from, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSec: 0, status: "rejected", summary: null, errors: [] }).catch(() => undefined);
      return sayAndHangup("Sorry, this line isn't available. Goodbye.");
    }
    if (!cfg.ANTHROPIC_API_KEY) return sayAndHangup("Your assistant isn't fully set up yet. Please add the Claude API key on the server.");
    const settings = await store.getSettings();
    return relayResponse(body.CallSid ?? "", settings.greeting);
  });

  // 2) Twilio calls this when the ConversationRelay session ends (hang-up, error, or dropped socket).
  app.post("/voice/connect-ended", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    reply.type("text/xml");
    if (!twilioValid(req, `${base}/voice/connect-ended`, body)) return reply.code(403).send(hangup());
    const sid = body.CallSid ?? "";
    const failed = body.SessionStatus === "failed" || Boolean(body.ErrorCode);
    if (failed && sessions.has(sid) && body.CallStatus !== "completed") {
      req.log.warn({ sid, error: body.ErrorMessage }, "Relay session failed; reconnecting");
      return relayResponse(sid, "Sorry, I lost you for a second. I'm back.");
    }
    return hangup();
  });

  // 3) The live voice WebSocket.
  app.get("/relay", { websocket: true }, (socket: WebSocket, req) => {
    const sigOk = cfg.SKIP_TWILIO_SIGNATURE || (cfg.TWILIO_AUTH_TOKEN && validTwilioSignature(cfg.TWILIO_AUTH_TOKEN, req.headers["x-twilio-signature"] as string | undefined, [`${wsBase}/relay`, `${base}/relay`]));
    if (!sigOk) req.log.warn("Relay handshake signature did not verify; relying on the signed call token");

    let relay: RelayConnection | null = null;
    let callSid = "";
    let callId: string | null = null;
    const startedAt = Date.now();

    socket.on("message", async (raw) => {
      let msg: RelayInbound;
      try { msg = JSON.parse(raw.toString()) as RelayInbound; } catch { return; }
      try {
        if (msg.type === "setup") {
          callSid = msg.callSid;
          const tokenOk = cfg.SKIP_TWILIO_SIGNATURE || verifyCallToken(cfg.TWILIO_AUTH_TOKEN ?? cfg.ENCRYPTION_KEY ?? "dev", msg.customParameters?.callToken, callSid);
          if (!tokenOk || !allowedCallers(cfg).has(msg.from)) {
            req.log.warn({ callSid, from: msg.from }, "Relay setup rejected");
            socket.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason: "unauthorized" }) }));
            socket.close();
            return;
          }
          const existing = sessions.get(callSid);
          let session: CallSession;
          if (existing) {
            session = existing.session;
            existing.detachedAt = null;
            callId = session.callId;
          } else {
            const call = await store.createCall({ callSid, fromNumber: msg.from, startedAt: new Date().toISOString(), endedAt: null, durationSec: null, status: "in_progress", summary: null, errors: [] });
            callId = call.id;
            session = new CallSession(cfg, store, ctx.registry, ctx.streamFn, callId, callSid);
            await session.init();
            sessions.set(callSid, { session, startedAt, detachedAt: null });
            await store.audit({ actor: "caller", action: "call_started", detail: { callSid, from: msg.from }, at: new Date().toISOString() }).catch(() => undefined);
          }
          relay = new RelayConnection(socket, session, req.log);
          return;
        }
        if (!relay) return; // ignore anything before a valid setup
        await relay.handle(msg);
      } catch (e) {
        req.log.error({ err: e }, "relay message failed");
      }
    });

    socket.on("close", async () => {
      relay?.close();
      const entry = sessions.get(callSid);
      if (!entry || !callId) return;
      entry.detachedAt = Date.now();
      // Give Twilio a moment to reconnect; if it doesn't, finalize the call.
      setTimeout(async () => {
        const e = sessions.get(callSid);
        if (!e || e.detachedAt === null) return;
        sessions.delete(callSid);
        const seconds = Math.round((Date.now() - e.startedAt) / 1000);
        await store.updateCall(callId!, { endedAt: new Date().toISOString(), durationSec: seconds, status: e.session.errors.length ? "completed" : "completed", errors: e.session.errors.slice(0, 20) }).catch(() => undefined);
        await store.recordUsage({ kind: "twilio", callId, minutes: Math.ceil(seconds / 60), costUsd: twilioCostUsd(seconds), at: new Date().toISOString() }).catch(() => undefined);
        if (ctx.anthropic) await summarizeCall(ctx.anthropic, cfg, store, callId!).catch((err) => app.log.error({ err }, "summary failed"));
      }, cfg.NODE_ENV === "test" ? 10 : 15_000);
    });
  });
}
