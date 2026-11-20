import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { signCallToken, twilioSignature } from "../src/lib/crypto.js";
import { InMemoryStore } from "../src/store/memoryStore.js";
import { FakeConnector, FakeRegistry, fakeTools, message, scriptedStream, testConfig } from "./helpers.js";

let app: FastifyInstance;
let base: string;
const store = new InMemoryStore();
const cfg = testConfig();
const { fn } = scriptedStream([message([{ type: "text", text: "Your next meeting is at three. " }])]);

beforeAll(async () => {
  const ctx = buildContext(cfg, { store, streamFn: fn, anthropic: null, supabase: null, registry: new FakeRegistry(cfg, store, new FakeConnector(fakeTools)) });
  app = await buildServer(ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await app.close(); });

const form = (p: Record<string, string>) => new URLSearchParams(p).toString();

describe("server", () => {
  it("serves health", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it("rejects /voice without a valid Twilio signature", async () => {
    const r = await fetch(`${base}/voice`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ From: "+15551112222", CallSid: "CA1" }) });
    expect(r.status).toBe(403);
  });

  it("answers the allowed caller with ConversationRelay TwiML", async () => {
    const params = { From: "+15551112222", To: "+15550000000", CallSid: "CA42", Direction: "inbound" };
    const sig = twilioSignature("twilio-secret", "https://pa.example.com/voice", params);
    const r = await fetch(`${base}/voice`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: form(params) });
    const xml = await r.text();
    expect(r.status).toBe(200);
    expect(xml).toContain('<ConversationRelay url="wss://pa.example.com/relay"');
    expect(xml).toContain('interruptible="any"');
    expect(xml).toContain('<Parameter name="callToken"');
    expect(xml).toContain('action="https://pa.example.com/voice/connect-ended"');
  });

  it("politely rejects unknown callers and logs it", async () => {
    const params = { From: "+19998887777", To: "+15550000000", CallSid: "CA43", Direction: "inbound" };
    const sig = twilioSignature("twilio-secret", "https://pa.example.com/voice", params);
    const r = await fetch(`${base}/voice`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: form(params) });
    const xml = await r.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("ConversationRelay");
    expect(store.audits.some((a) => a.action === "call_rejected")).toBe(true);
  });

  it("requires sign-in for the dashboard API", async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
  });

  it("runs a live voice turn over the relay WebSocket", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/relay`);
    const tokens: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "text") { tokens.push(m.token); if (m.last) done(); }
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "setup", callSid: "CA42", from: "+15551112222", to: "+15550000000", customParameters: { callToken: signCallToken("twilio-secret", "CA42") } }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "What's next on my calendar?", last: true }));
    await finished;
    expect(tokens.join("")).toBe("Your next meeting is at three. ");
    const call = await store.getCallBySid("CA42");
    expect(call?.status).toBe("in_progress");
    ws.close();
    await new Promise((r) => setTimeout(r, 60));
    const ended = await store.getCallBySid("CA42");
    expect(ended?.status).toBe("completed");
    const lines = await store.getTranscript(ended!.id);
    expect(lines.map((l) => l.role)).toEqual(["caller", "assistant"]);
  });

  it("closes relay sessions with a forged call token", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/relay`);
    await new Promise((r) => ws.on("open", r));
    const msgs: string[] = [];
    ws.on("message", (raw) => msgs.push(raw.toString()));
    const closed = new Promise((r) => ws.on("close", r));
    ws.send(JSON.stringify({ type: "setup", callSid: "CA99", from: "+15551112222", to: "+1", customParameters: { callToken: "CA99.9999999999.forged" } }));
    await closed;
    expect(msgs[0]).toContain('"type":"end"');
  });
});
