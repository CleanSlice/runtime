import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { createLogger } from "../../logger"

const log = createLogger("mcp")

/** Minimal per-agent secret store (SecretModule satisfies this). */
export interface ISecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

/**
 * What Ranch stored under `mcpOauth:<serverId>` after the in-chat Connect flow.
 * Mirrors the api-side IMcpOauthBundle. camelCase — our own contract.
 */
interface IMcpOauthBundle {
  clientId: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scope: string | null
}

export const mcpOauthSecretKey = (serverId: string): string =>
  `mcpOauth:${serverId}`

/**
 * Headless OAuthClientProvider for an already-connected MCP server (CLEAN-75).
 * The interactive authorize half ran in Ranch; here we only ever hold a
 * refresh token and let the MCP SDK refresh the access token on 401 without a
 * browser. Rotated tokens are persisted back to the agent secret so they
 * survive a pod restart. `redirectToAuthorization` is unreachable while the
 * refresh token is valid — if it is ever hit, the token died and the user must
 * reconnect from the chat.
 */
export class RuntimeMcpOauthProvider implements OAuthClientProvider {
  private cached?: IMcpOauthBundle
  private verifier?: string

  constructor(
    private readonly serverId: string,
    private readonly secrets: ISecretStore,
  ) {}

  private async load(): Promise<IMcpOauthBundle | undefined> {
    if (this.cached) return this.cached
    const raw = await this.secrets.get(mcpOauthSecretKey(this.serverId))
    if (!raw) return undefined
    try {
      this.cached = JSON.parse(raw) as IMcpOauthBundle
      return this.cached
    } catch (err) {
      log.warn(`oauth: bad token bundle for ${this.serverId} — ${(err as Error).message}`)
      return undefined
    }
  }

  // Never used for refresh (no authorize), but the getter must return a valid
  // shape. A placeholder redirect keeps the zod metadata schema happy.
  get redirectUrl(): string {
    return "https://ranch.invalid/oauth/callback"
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Ranch",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const b = await this.load()
    return b ? { client_id: b.clientId } : undefined
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const b = await this.load()
    if (!b) return undefined
    const expiresIn =
      b.expiresAt != null
        ? Math.max(0, Math.floor((b.expiresAt - Date.now()) / 1000))
        : undefined
    return {
      access_token: b.accessToken,
      token_type: "Bearer",
      ...(b.refreshToken ? { refresh_token: b.refreshToken } : {}),
      ...(expiresIn != null ? { expires_in: expiresIn } : {}),
      ...(b.scope ? { scope: b.scope } : {}),
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const prev = (await this.load()) ?? ({} as Partial<IMcpOauthBundle>)
    const next: IMcpOauthBundle = {
      clientId: prev.clientId ?? "",
      issuer: prev.issuer ?? "",
      authorizationEndpoint: prev.authorizationEndpoint ?? "",
      tokenEndpoint: prev.tokenEndpoint ?? "",
      accessToken: tokens.access_token,
      // Preserve the existing refresh token when the server doesn't rotate.
      refreshToken: tokens.refresh_token ?? prev.refreshToken ?? null,
      expiresAt:
        tokens.expires_in != null
          ? Date.now() + tokens.expires_in * 1000
          : (prev.expiresAt ?? null),
      scope: tokens.scope ?? prev.scope ?? null,
    }
    this.cached = next
    await this.secrets.set(mcpOauthSecretKey(this.serverId), JSON.stringify(next))
  }

  redirectToAuthorization(): void {
    throw new Error(
      "MCP OAuth token expired or revoked — the user must reconnect from the chat",
    )
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("no PKCE code_verifier in this context")
    return this.verifier
  }
}
