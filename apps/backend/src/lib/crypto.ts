import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** AES-256-GCM envelope for secrets at rest (OAuth refresh tokens, API keys). */
export class SecretBox {
  private key: Buffer;
  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    this.key = key;
  }
  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
  }
  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognized secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Twilio request signature (X-Twilio-Signature): HMAC-SHA1 over the full URL
 * followed by each POST parameter name+value sorted by name, base64-encoded.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string> = {}): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(
  authToken: string,
  signature: string | undefined,
  urls: string[],
  params: Record<string, string> = {},
): boolean {
  if (!signature) return false;
  return urls.some((u) => safeEqual(twilioSignature(authToken, u, params), signature));
}

/** Short-lived HMAC token tying a WebSocket session to the /voice webhook that created it. */
export function signCallToken(secret: string, callSid: string, ttlSec = 120): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${callSid}.${exp}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyCallToken(secret: string, token: string | undefined, callSid: string): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [sid, exp, mac] = parts as [string, string, string];
  if (sid !== callSid || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", secret).update(`${sid}.${exp}`).digest("base64url");
  return safeEqual(expected, mac);
}
