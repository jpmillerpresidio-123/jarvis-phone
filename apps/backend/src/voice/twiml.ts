import type { AssistantSettings } from "../store/types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** TwiML that hands the call to ConversationRelay over our WebSocket. */
export function relayTwiml(opts: {
  wsUrl: string;
  actionUrl: string;
  callToken: string;
  settings: AssistantSettings;
  greeting: string | null;
}) {
  const s = opts.settings;
  const attrs: Record<string, string> = {
    url: opts.wsUrl,
    language: s.language,
    ttsProvider: s.ttsProvider,
    transcriptionProvider: "Deepgram",
    interruptible: "any",
    interruptSensitivity: "medium",
    welcomeGreetingInterruptible: "any",
    dtmfDetection: "true",
    // ElevenLabs reads numbers, dates and times naturally with normalization on.
    ...(s.ttsProvider === "ElevenLabs" ? { elevenlabsTextNormalization: "on" } : {}),
  };
  if (s.voice) attrs.voice = s.voice;
  if (opts.greeting) attrs.welcomeGreeting = opts.greeting;
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${esc(opts.actionUrl)}">
    <ConversationRelay ${attrStr}>
      <Parameter name="callToken" value="${esc(opts.callToken)}"/>
    </ConversationRelay>
  </Connect>
</Response>`;
}

export function sayAndHangup(text: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>${esc(text)}</Say><Hangup/></Response>`;
}

export function hangup() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`;
}
