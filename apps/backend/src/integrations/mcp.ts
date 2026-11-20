import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Connector, ToolDescriptor, ToolResult } from "./types.js";
import { textResult } from "./types.js";

/**
 * Generic remote MCP server connector. This is how integrations get added later
 * without rebuilding: paste a server URL in the dashboard, sign in once (MCP OAuth
 * with dynamic client registration + PKCE, or a static API token), and its tools
 * are discovered live with tools/list.
 */

export interface McpSecret {
  mode: "oauth" | "token" | "none";
  token?: string; // static bearer for mode "token"
  oauth?: {
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    state?: string;
  };
}

export class StoredOAuthProvider implements OAuthClientProvider {
  pendingAuthorizationUrl: URL | null = null;
  constructor(
    private secret: McpSecret,
    private redirectUri: string,
    private stateValue: string,
    private persist: (s: McpSecret) => Promise<void>,
  ) {
    this.secret.oauth ??= {};
  }
  get redirectUrl() { return this.redirectUri; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Personal AI Assistant",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() { this.secret.oauth!.state = this.stateValue; return this.stateValue; }
  clientInformation() { return this.secret.oauth!.clientInformation; }
  async saveClientInformation(info: OAuthClientInformationMixed) { this.secret.oauth!.clientInformation = info; await this.persist(this.secret); }
  tokens() { return this.secret.oauth!.tokens; }
  async saveTokens(tokens: OAuthTokens) { this.secret.oauth!.tokens = tokens; await this.persist(this.secret); }
  redirectToAuthorization(url: URL) { this.pendingAuthorizationUrl = url; }
  async saveCodeVerifier(v: string) { this.secret.oauth!.codeVerifier = v; await this.persist(this.secret); }
  codeVerifier() {
    const v = this.secret.oauth!.codeVerifier;
    if (!v) throw new Error("Missing PKCE verifier; restart the connection");
    return v;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const o = this.secret.oauth!;
    if (scope === "all" || scope === "client") delete o.clientInformation;
    if (scope === "all" || scope === "tokens") delete o.tokens;
    if (scope === "all" || scope === "verifier") delete o.codeVerifier;
    await this.persist(this.secret);
  }
}

/** Starts (or completes, with `code`) the MCP OAuth flow. Returns a URL to send the owner to, or null if authorized. */
export async function mcpAuthorize(serverUrl: string, provider: StoredOAuthProvider, code?: string): Promise<URL | null> {
  const r = await auth(provider, { serverUrl, authorizationCode: code });
  if (r === "AUTHORIZED") return null;
  if (!provider.pendingAuthorizationUrl) throw new Error("Server did not provide an authorization URL");
  return provider.pendingAuthorizationUrl;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);

export class McpConnector implements Connector {
  private client: Client | null = null;
  private toolsCache: ToolDescriptor[] | null = null;
  /** sanitized Claude tool name -> original MCP tool name */
  private originalNames = new Map<string, string>();
  readonly prefix: string;

  constructor(
    public id: string,
    public displayName: string,
    private serverUrl: string,
    private secret: McpSecret,
    private provider: StoredOAuthProvider | null,
  ) {
    this.prefix = slug(displayName) || "mcp";
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const headers: Record<string, string> = {};
    if (this.secret.mode === "token" && this.secret.token) headers.authorization = `Bearer ${this.secret.token}`;
    const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), {
      authProvider: this.secret.mode === "oauth" ? (this.provider ?? undefined) : undefined,
      requestInit: { headers },
    });
    const client = new Client({ name: "personal-ai-assistant", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async close() {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (this.toolsCache) return this.toolsCache;
    const client = await this.connect();
    const out: ToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        const safe = `${this.prefix}__${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
        this.originalNames.set(safe, t.name);
        const schema = (t.inputSchema as Record<string, unknown>) ?? {};
        out.push({
          name: safe,
          description: `[${this.displayName}] ${t.description ?? t.title ?? t.name}`.slice(0, 1024),
          inputSchema: { ...schema, type: "object", properties: schema.properties ?? {} },
          annotations: t.annotations
            ? { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint, idempotentHint: t.annotations.idempotentHint, openWorldHint: t.annotations.openWorldHint }
            : undefined,
          describe: (i) => `use ${this.displayName} to ${t.name.replace(/[_-]+/g, " ")}${Object.keys(i).length ? ` with ${JSON.stringify(i).slice(0, 160)}` : ""}`,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.toolsCache = out;
    return out;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.connect();
    if (!this.toolsCache) await this.listTools();
    const bare = this.originalNames.get(name) ?? name;
    const r = await client.callTool({ name: bare, arguments: input });
    const content = Array.isArray(r.content) ? r.content : [];
    const text = content
      .map((c: { type: string; text?: string; resource?: { uri?: string; text?: string } }) =>
        c.type === "text" ? c.text : c.type === "resource" ? (c.resource?.text ?? c.resource?.uri) : `[${c.type} content]`)
      .filter(Boolean)
      .join("\n");
    const structured = r.structuredContent ? `\n${JSON.stringify(r.structuredContent).slice(0, 4000)}` : "";
    return textResult(!r.isError, (text || "(no text returned)") + structured);
  }

  async test() {
    this.toolsCache = null;
    const tools = await this.listTools();
    return { ok: tools.length > 0, detail: tools.length ? `Discovered ${tools.length} tools` : "Server returned no tools", toolCount: tools.length };
  }
}
