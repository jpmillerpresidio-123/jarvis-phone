"use client";
import { SettingsForm } from "@/components/SettingsForm";
import { Card, Field, Input, PageHeader, Row, Select, Textarea, Toggle } from "@/components/ui";

export default function AssistantPage() {
  return (
    <>
      <PageHeader title="My Assistant" subtitle="Personality, voice and how it remembers things." />
      <SettingsForm>
        {(d, set) => (
          <>
            <Card title="Personality">
              <div className="grid gap-5 md:grid-cols-2">
                <Field label="Name"><Input value={d.assistantName} maxLength={40} onChange={(e) => set("assistantName", e.target.value)} /></Field>
                <Field label="Greeting" hint="Spoken when it answers."><Input value={d.greeting} maxLength={200} onChange={(e) => set("greeting", e.target.value)} /></Field>
                <Field label="Your name" hint="What it calls you."><Input value={d.ownerName ?? ""} maxLength={40} onChange={(e) => set("ownerName", e.target.value)} /></Field>
                <Field label="Your teams" hint="Comma-separated, e.g. Warriors, 49ers. Used for scores and the daily rundown."><Input value={d.sportsTeams ?? ""} maxLength={300} onChange={(e) => set("sportsTeams", e.target.value)} /></Field>
              </div>
              <div className="mt-5"><Field label="Personality" hint="Describe how it should sound and behave."><Textarea rows={3} maxLength={600} value={d.personality} onChange={(e) => set("personality", e.target.value)} /></Field></div>
            </Card>

            <Card title="Responses">
              <Row label="Answer length" hint="Phone answers work best short.">
                <Select value={d.responseStyle} onChange={(v) => set("responseStyle", v as typeof d.responseStyle)} options={[{ value: "brief", label: "Brief" }, { value: "balanced", label: "Balanced" }, { value: "detailed", label: "Detailed" }]} />
              </Row>
              <Row label="Confirm every change" hint="Also ask before creating drafts, events and docs. Sending, deleting and sharing always ask.">
                <Toggle checked={d.confirmWrites} onChange={(v) => set("confirmWrites", v)} label="Confirm every change" />
              </Row>
              <Row label="Web search" hint="Look up news, weather, prices and anything current. About 1¢ per search.">
                <Toggle checked={d.webSearch ?? true} onChange={(v) => set("webSearch", v)} label="Web search" />
              </Row>
              <Row label="Time zone"><Input className="max-w-[220px]" value={d.timezone} onChange={(e) => set("timezone", e.target.value)} /></Row>
            </Card>

            <Card title="Voice">
              <Row label="Voice provider" hint="Twilio's text-to-speech partner.">
                <Select value={d.ttsProvider} onChange={(v) => set("ttsProvider", v as typeof d.ttsProvider)} options={["ElevenLabs", "Google", "Amazon"].map((x) => ({ value: x, label: x }))} />
              </Row>
              <Row label="Voice ID" hint="Leave blank for the provider's default voice.">
                <Input className="max-w-[260px]" placeholder="Default" value={d.voice ?? ""} onChange={(e) => set("voice", e.target.value || null)} />
              </Row>
              <Row label="Language"><Input className="max-w-[120px]" value={d.language} onChange={(e) => set("language", e.target.value)} /></Row>
            </Card>

            <Card title="Memory">
              <Row label="Use memory" hint="Recall saved facts and past calls during conversations."><Toggle checked={d.memoryEnabled} onChange={(v) => set("memoryEnabled", v)} label="Use memory" /></Row>
              <Row label="Save new memories after calls" hint="Summaries pick out durable preferences and decisions. Sensitive data is never saved."><Toggle checked={d.autoSaveMemories} onChange={(v) => set("autoSaveMemories", v)} label="Auto-save memories" /></Row>
            </Card>
          </>
        )}
      </SettingsForm>
    </>
  );
}
