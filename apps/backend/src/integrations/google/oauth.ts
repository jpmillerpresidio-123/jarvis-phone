/** Google OAuth 2.0 (authorization-code + refresh token), done by this app itself. */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify", // read, label, draft, send, trash (no permanent delete)
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file", // only files this app creates
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/contacts.readonly",
];

export interface GoogleTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
}

export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // guarantees a refresh token
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  return json as { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };
}

export async function exchangeCode(clientId: string, clientSecret: string, redirectUri: string, code: string) {
  return tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
}

export async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  return tokenRequest({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" });
}

export async function googleAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return ((await res.json()) as { email?: string }).email ?? null;
}
