import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { CallSession } from "../agent/engine.js";

/** Messages Twilio ConversationRelay sends us. */
export type RelayInbound =
  | { type: "setup"; callSid: string; from: string; to: string; direction?: string; customParameters?: Record<string, string>; connectionType?: string }
  | { type: "prompt"; voicePrompt: string; lang?: string; last?: boolean }
  | { type: "interrupt"; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }
  | { type: "dtmf"; digit: string }
  | { type: "info"; name?: string; value?: unknown }
  | { type: "error"; description: string };

/**
 * Drives one live call: forwards caller speech to the CallSession, streams
 * Claude's text back token by token (Twilio speaks it), and handles barge-in
 * and keypad PIN entry.
 */
export class RelayConnection {
  private inflight: AbortController | null = null;
  private interruptedAfter: string | undefined;
  private pinBuffer = "";
  private turnChain: Promise<void> = Promise.resolve();

  constructor(
    private ws: WebSocket,
    private session: CallSession,
    private log: FastifyBaseLogger,
  ) {}

  send(msg: Record<string, unknown>) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  say(text: string) {
    this.send({ type: "text", token: text, last: true });
  }

  private sink() {
    return {
      onText: (token: string) => this.send({ type: "text", token, last: false }),
      onTurnEnd: () => this.send({ type: "text", token: "", last: true }),
    };
  }

  /** Runs turns one at a time; a new caller turn cancels the one still generating. */
  private startTurn(run: (signal: AbortSignal) => Promise<void>) {
    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    this.turnChain = this.turnChain
      .catch(() => undefined)
      .then(() => (ctrl.signal.aborted ? undefined : run(ctrl.signal)))
      .catch((e) => this.log.error({ err: e }, "turn failed"))
      .finally(() => { if (this.inflight === ctrl) this.inflight = null; });
    return this.turnChain;
  }

  handle(msg: RelayInbound): Promise<void> | void {
    switch (msg.type) {
      case "prompt": {
        if (msg.last === false) return; // partial transcript
        const text = msg.voicePrompt?.trim();
        if (!text) return;
        const interruptedAfter = this.interruptedAfter;
        this.interruptedAfter = undefined;
        return this.startTurn((signal) => this.session.respond(text, this.sink(), signal, { interruptedAfter }));
      }
      case "interrupt":
        this.inflight?.abort();
        this.interruptedAfter = msg.utteranceUntilInterrupt || this.interruptedAfter;
        return;
      case "dtmf": {
        if (!this.session.awaitingPinFor) return;
        if (msg.digit === "#") {
          const ok = this.session.verifyPin(this.pinBuffer);
          this.pinBuffer = "";
          if (ok) {
            this.session.awaitingPinFor = null;
            return this.startTurn((signal) => this.session.resumeAfterPin(this.sink(), signal));
          }
          this.say("That PIN didn't match. Please try again, then press pound.");
          return;
        }
        if (/^[0-9]$/.test(msg.digit) && this.pinBuffer.length < 12) this.pinBuffer += msg.digit;
        return;
      }
      case "error":
        this.log.warn({ description: msg.description }, "ConversationRelay error");
        this.session.errors.push(`Relay: ${msg.description}`);
        return;
      default:
        return;
    }
  }

  async idle() {
    await this.turnChain.catch(() => undefined);
  }

  close() {
    this.inflight?.abort();
  }
}
