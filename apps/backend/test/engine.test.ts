import { describe, expect, it } from "vitest";
import { CallSession } from "../src/agent/engine.js";
import { InMemoryStore } from "../src/store/memoryStore.js";
import { FakeConnector, FakeRegistry, fakeTools, message, scriptedStream, testConfig, type ScriptItem } from "./helpers.js";

function setup(script: ScriptItem[], cfgOver: Record<string, string> = {}) {
  const cfg = testConfig(cfgOver);
  const store = new InMemoryStore();
  const fake = new FakeConnector(fakeTools);
  const registry = new FakeRegistry(cfg, store, fake);
  const { fn, requests } = scriptedStream(script);
  const session = new CallSession(cfg, store, registry, fn, "call-1", "CA1");
  const spoken: string[] = [];
  const sink = { onText: (t: string) => spoken.push(t), onTurnEnd: () => spoken.push("<END>") };
  return { cfg, store, fake, session, requests, spoken, sink };
}

const lastToolResult = (requests: unknown[]) => {
  const req = requests.at(-1) as { messages: { role: string; content: unknown }[] };
  const last = req.messages.at(-1)!;
  return JSON.stringify(last.content);
};

describe("CallSession", () => {
  it("streams spoken text and sends cached system prompt, tools, effort and fallbacks", async () => {
    const t = setup([message([{ type: "text", text: "Hi there, how can I help?" }])]);
    await t.session.init();
    await t.session.respond("hello", t.sink);
    expect(t.spoken.join("")).toBe("Hi there, how can I help?<END>");
    const req = t.requests[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config.effort).toBe("low");
    expect(req.fallbacks).toBe("default");
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.tools.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["mail__search", "mail__send", "confirm_action", "memory__remember"]));
    expect(t.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs read tools immediately and wraps output as untrusted data", async () => {
    const t = setup([
      message([{ type: "text", text: "Let me check. " }, { type: "tool_use", name: "mail__search", input: { q: "invoice" } }]),
      message([{ type: "text", text: "You have one invoice email." }]),
    ]);
    await t.session.init();
    await t.session.respond("any invoices?", t.sink);
    expect(t.fake.calls).toEqual([{ name: "mail__search", input: { q: "invoice" } }]);
    expect(lastToolResult(t.requests)).toContain("trust=\\\"untrusted-data\\\"");
    const tasks = await t.store.listTasks({});
    expect(tasks[0]!.status).toBe("completed");
  });

  it("requires a new spoken yes before a consequential action runs, and runs it once", async () => {
    const actionIdFrom = (req: Record<string, unknown>) => {
      const all = JSON.stringify(req.messages);
      return /action_id=([a-f0-9]{8})/.exec(all)![1]!;
    };
    const t = setup([
      message([{ type: "tool_use", name: "mail__send", input: { to: "sam@x.com" } }]),
      message([{ type: "text", text: "I'm about to send an email to sam. Should I go ahead?" }]),
      (req) => message([{ type: "tool_use", name: "confirm_action", input: { action_id: actionIdFrom(req) } }]),
      message([{ type: "text", text: "Sent." }]),
      // the model tries to send the identical email again later in the call
      message([{ type: "tool_use", name: "mail__send", input: { to: "sam@x.com" } }]),
      message([{ type: "text", text: "That was already sent." }]),
    ]);
    await t.session.init();
    await t.session.respond("email sam that I'm late", t.sink);
    expect(t.fake.calls).toHaveLength(0);
    expect(lastToolResult(t.requests)).toContain("CONFIRMATION_REQUIRED");
    await t.session.respond("yes, go ahead", t.sink);
    expect(t.fake.calls).toEqual([{ name: "mail__send", input: { to: "sam@x.com" } }]);
    expect(t.spoken.join("")).toContain("Sent.");
    expect(t.store.audits.some((a) => a.action === "confirmed_action")).toBe(true);
    await t.session.respond("did you send it?", t.sink);
    expect(t.fake.calls).toHaveLength(1);
    expect(lastToolResult(t.requests)).toContain("Already done");
  });

  it("refuses confirm_action in the same turn the confirmation was requested", async () => {
    const t = setup([
      message([{ type: "tool_use", name: "mail__send", input: { to: "a@b.c" } }]),
      message([{ type: "text", text: "ok" }]),
    ]);
    await t.session.init();
    await t.session.respond("send it", t.sink);
    const id = /action_id=([a-f0-9]{8})/.exec(lastToolResult(t.requests))![1]!;
    const r = await (t.session as unknown as { confirm: (u: string, id: string) => Promise<{ is_error?: boolean; content: string }> }).confirm("toolu_x", id);
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("hasn't answered");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("does not treat 'no, wait' as confirmation", async () => {
    const t = setup([
      message([{ type: "tool_use", name: "mail__send", input: { to: "a@b.c" } }]),
      message([{ type: "text", text: "Should I?" }]),
      message([{ type: "text", text: "Okay, I won't." }]),
    ]);
    await t.session.init();
    await t.session.respond("send it", t.sink);
    const id = /action_id=([a-f0-9]{8})/.exec(lastToolResult(t.requests))![1]!;
    await t.session.respond("no wait, don't", t.sink);
    const r = await (t.session as unknown as { confirm: (u: string, id: string) => Promise<{ is_error?: boolean; content: string }> }).confirm("toolu_y", id);
    expect(r.is_error).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("blocks outbound calling tools outright", async () => {
    const t = setup([
      message([{ type: "tool_use", name: "phone__make_call", input: {} }]),
      message([{ type: "text", text: "I can't place calls." }]),
    ]);
    await t.session.init();
    await t.session.respond("call my mom", t.sink);
    expect(t.fake.calls).toHaveLength(0);
    expect(lastToolResult(t.requests)).toContain("BLOCKED");
    expect((await t.store.listTasks({}))[0]!.status).toBe("blocked");
  });

  it("asks for the keypad PIN before executing when VOICE_PIN is set", async () => {
    const t = setup([
      message([{ type: "tool_use", name: "mail__send", input: { to: "a@b.c" } }]),
      message([{ type: "text", text: "Should I go ahead?" }]),
    ], { VOICE_PIN: "4321" });
    await t.session.init();
    await t.session.respond("send it", t.sink);
    const id = /action_id=([a-f0-9]{8})/.exec(lastToolResult(t.requests))![1]!;
    (t.session as unknown as { userTurn: number; lastUserText: string }).userTurn++;
    (t.session as unknown as { lastUserText: string }).lastUserText = "yes";
    const r = await (t.session as unknown as { confirm: (u: string, id: string) => Promise<{ content: string }> }).confirm("toolu_z", id);
    expect(r.content).toContain("PIN_REQUIRED");
    expect(t.session.awaitingPinFor).toBe(id);
    expect(t.session.verifyPin("1111")).toBe(false);
    expect(t.session.verifyPin("4321")).toBe(true);
    const r2 = await (t.session as unknown as { confirm: (u: string, id: string) => Promise<{ content: string }> }).confirm("toolu_z2", id);
    expect(r2.content).toContain("done mail__send");
    expect(t.fake.calls).toHaveLength(1);
  });

  it("drops a turn cleanly when the caller interrupts", async () => {
    const t = setup([
      message([{ type: "text", text: "This is a very long answer that keeps going and going and going." }]),
      message([{ type: "text", text: "Sure, shorter." }]),
    ]);
    await t.session.init();
    const ctrl = new AbortController();
    const p = t.session.respond("tell me everything", t.sink, ctrl.signal);
    setTimeout(() => ctrl.abort(), 3);
    await p;
    await t.session.respond("shorter please", t.sink, undefined, { interruptedAfter: "This is a very" });
    const roles = t.session.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]); // aborted turn discarded, caller text merged
    expect(JSON.stringify(t.session.messages[0]!.content)).toContain("interrupted you after you said");
  });

  it("saves memories but refuses sensitive ones", async () => {
    const t = setup([
      message([{ type: "tool_use", name: "memory__remember", input: { content: "Prefers morning meetings", category: "preference" } }, { type: "tool_use", name: "memory__remember", input: { content: "my password is hunter2", category: "other" } }]),
      message([{ type: "text", text: "Got it." }]),
    ]);
    await t.session.init();
    await t.session.respond("remember I like mornings", t.sink);
    const mems = await t.store.listMemories();
    expect(mems.map((m) => m.content)).toEqual(["Prefers morning meetings"]);
  });
});
