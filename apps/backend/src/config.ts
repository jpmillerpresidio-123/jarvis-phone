import { z } from "zod";

/**
 * All configuration comes from environment variables (Railway in production,
 * a local .env in development). Nothing secret is ever hardcoded.
 * Optional groups let the server boot and report "not configured" in the
 * dashboard instead of crashing, so you can see exactly what is missing.
 */
const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  /** Public https base URL of this backend, e.g. https://pa-backend.up.railway.app */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  /** Dashboard origin allowed by CORS, e.g. https://pa-dashboard.vercel.app */
  DASHBOARD_ORIGIN: z.string().url().default("http://localhost:3000"),

  // Claude
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  SUMMARY_MODEL: z.string().default("claude-opus-5-5"),

  // Twilio (inbound only)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  /** Comma-separated E.164 numbers allowed to call in. Empty = reject everyone. */
  ALLOWED_CALLERS: z.string().default(""),
  /** Optional keypad PIN required before consequential actions. */
  VOICE_PIN: z.string().regex(/^\d{4,8}$/).optional(),
  SKIP_TWILIO_SIGNATURE: bool, // local testing only; refused in production

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /** The only account allowed into the dashboard / API. */
  OWNER_EMAIL: z.string().email().optional(),

  /** 32-byte key, base64. Encrypts OAuth tokens and API keys at rest. */
  ENCRYPTION_KEY: z.string().optional(),

  // Google OAuth (Gmail, Calendar, Drive, Docs, Sheets)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /** Blackbaud assignment iCal feed link (works like a password; server-only). */
  BLACKBAUD_ICAL: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : undefined),
    z.string().regex(/^(https|webcal):\/\//i, "must be an https:// or webcal:// link").optional()),

  // Usage warnings
  MONTHLY_BUDGET_USD: z.coerce.number().default(50),
  HOSTING_MONTHLY_USD: z.coerce.number().default(5),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production" && cfg.SKIP_TWILIO_SIGNATURE) {
    throw new Error("SKIP_TWILIO_SIGNATURE must never be enabled in production");
  }
  return cfg;
}

export function allowedCallers(cfg: Config): Set<string> {
  return new Set(
    cfg.ALLOWED_CALLERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** What the dashboard's "Environment configuration status" panel shows. Never returns values. */
export function configStatus(cfg: Config) {
  return {
    claude: Boolean(cfg.ANTHROPIC_API_KEY),
    twilio: Boolean(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_PHONE_NUMBER),
    allowedCallers: allowedCallers(cfg).size,
    voicePin: Boolean(cfg.VOICE_PIN),
    supabase: Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_ROLE_KEY),
    owner: Boolean(cfg.OWNER_EMAIL),
    encryption: Boolean(cfg.ENCRYPTION_KEY),
    google: Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET),
    blackbaud: Boolean(cfg.BLACKBAUD_ICAL),
    model: cfg.CLAUDE_MODEL,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
  };
}
