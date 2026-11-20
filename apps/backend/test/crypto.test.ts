import { describe, expect, it } from "vitest";
import { SecretBox, signCallToken, twilioSignature, validTwilioSignature, verifyCallToken } from "../src/lib/crypto.js";
import { TEST_KEY } from "./helpers.js";

describe("crypto", () => {
  it("seals and opens secrets, and rejects tampering", () => {
    const box = new SecretBox(TEST_KEY);
    const sealed = box.seal("refresh-token-123");
    expect(sealed).not.toContain("refresh-token-123");
    expect(box.open(sealed)).toBe("refresh-token-123");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("evil").toString("base64");
    expect(() => box.open(parts.join("."))).toThrow();
  });

  it("validates Twilio signatures over URL + sorted params", () => {
    const params = { From: "+15551112222", CallSid: "CA1", To: "+15550000000" };
    const sig = twilioSignature("tok", "https://pa.example.com/voice", params);
    expect(validTwilioSignature("tok", sig, ["https://pa.example.com/voice"], params)).toBe(true);
    expect(validTwilioSignature("tok", sig, ["https://pa.example.com/voice"], { ...params, From: "+1999" })).toBe(false);
    expect(validTwilioSignature("other", sig, ["https://pa.example.com/voice"], params)).toBe(false);
    expect(validTwilioSignature("tok", undefined, ["https://pa.example.com/voice"], params)).toBe(false);
  });

  it("binds call tokens to a call sid", () => {
    const tok = signCallToken("s", "CA1");
    expect(verifyCallToken("s", tok, "CA1")).toBe(true);
    expect(verifyCallToken("s", tok, "CA2")).toBe(false);
    expect(verifyCallToken("x", tok, "CA1")).toBe(false);
  });
});
