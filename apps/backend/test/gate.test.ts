import { describe, expect, it } from "vitest";
import { classify, isHardBlocked } from "../src/agent/gate.js";
import type { ToolDescriptor } from "../src/integrations/types.js";

const t = (name: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({ name, description: "", inputSchema: {}, ...extra });

describe("gate", () => {
  it("hard-blocks outbound calls and purchases regardless of policy", () => {
    for (const n of ["twilio__create_call", "phone__make_call", "shop__purchase", "x__checkout", "higgsfield__gpu_rent", "x__add_credits", "x__make_outbound_call"]) {
      expect(isHardBlocked(n), n).toBe(true);
      expect(classify(t(n), {}, "auto", false)).toBe("blocked");
    }
  });

  it("classifies by name when nothing else is declared", () => {
    expect(classify(t("gmail__search"), {}, undefined, false)).toBe("read");
    expect(classify(t("x__create_label"), {}, undefined, false)).toBe("write");
    expect(classify(t("x__send_message"), {}, undefined, false)).toBe("consequential");
    expect(classify(t("x__delete_event"), {}, undefined, false)).toBe("consequential");
    expect(classify(t("x__frobnicate"), {}, undefined, false)).toBe("consequential"); // unknown = careful
  });

  it("respects MCP annotations and connector-declared risk", () => {
    expect(classify(t("x__frobnicate", { annotations: { readOnlyHint: true } }), {}, undefined, false)).toBe("read");
    expect(classify(t("x__update", { annotations: { destructiveHint: true } }), {}, undefined, false)).toBe("consequential");
    const cal = t("calendar__create_event", { risk: (i) => (Array.isArray(i.attendees) && i.attendees.length ? "consequential" : "write") });
    expect(classify(cal, {}, undefined, false)).toBe("write");
    expect(classify(cal, { attendees: ["a@b.com"] }, undefined, false)).toBe("consequential");
  });

  it("applies owner policies and confirmWrites", () => {
    expect(classify(t("gmail__search"), {}, "block", false)).toBe("blocked");
    expect(classify(t("gmail__search"), {}, "confirm", false)).toBe("consequential");
    expect(classify(t("x__create_label"), {}, undefined, true)).toBe("consequential");
  });
});
