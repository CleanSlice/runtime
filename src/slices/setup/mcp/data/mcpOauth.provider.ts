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
  /** Names in the store; lets the gateway find who already connected. */
  list?(): Promise<string[]>
}

/**
 * What Ranch stored after the in-chat Connect flow. Mirrors the api-side
 * IMcpOauthBundle (ranch: mcpServer/oauth/domain/mcpOauth.types.ts).
 * camelCase — our own contract.
 */
export interface IMcpOauthBundle {
  clientId: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint?: string | null
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scope: string | null
  /** Whose token this is (CLEAN-80); absent on agent-wide bundles. */
  subject?: string
  /** For "connected as …". */
  email?: string
  connectedAt?: number
  /** Bumped here on use; what Ranch's sweep reads for per-browser subjects. */
  lastUsedAt?: number
}

export const MCP_OAUTH_SECRET_PREFIX = "mcpOauth:"

/**
 * Secret key for a server's bundle: the person's own
 * (`mcpOauth:<serverId>:<subject>`, CLEAN-80) or the agent-wide one
 * (`mcpOauth:<serverId>`) that a Connect started on the agent's behalf wrote.
 */
export const mcpOauthSecretKey = (serverId: string, subject?: string): string =>
  subject
    ? `${MCP_OAUTH_SECRET_PREFIX}${serverId}:${subject}`
    : `${MCP_OAUTH_SECRET_PREFIX}${serverId}`

/** The subject a secret name is keyed to, or null for the agent-wide bundle. */
export function subjectOfSecretKey(serverId: string, name: string): string | null | undefined {
  const own = `${MCP_OAUTH_SECRET_PREFIX}${serverId}`
  if (name === own) return null
  if (name.startsWith(`${own}:`)) return name.slice(own.length + 1) || undefined
  return undefined
}

/**
 * Which bundle a subject should use: their own when they connected, else
 * the agent-wide one, else nothing. The same order Ranch's status route
 * answers in, so "connected" means the same on both sides.
 */
export async function resolveBundleKey(
  secrets: ISecretStore,
  serverId: string,
  subject: string,
): Promise<string | null> {
  const personal = mcpOauthSecretKey(serverId, subject)
  if (await secrets.get(personal)) return personal
  const shared = mcpOauthSecretKey(serverId)
  if (await secrets.get(shared)) return shared
  return null
}

/** Don't rewrite the secret on every tool call; once an hour is plenty. */
const USED_MARK_INTERVAL_MS = 60 * 60 * 1000

/**
 * Headless OAuthClientProvider for an already-connected MCP server (CLEAN-75).
 * The interactive authorize half ran in Ranch; here we only ever hold a
 * refresh token and let the MCP SDK refresh the access token on 401 without a
 * browser. Rotated tokens are persisted back to the agent secret so they
 * survive a pod restart. One provider per secret key — a person's own bundle
 * or the agent-wide one (CLEAN-80). `redirectToAuthorization` is unreachable
 * while the refresh token is valid — if it is ever hit, the token died and the
 * person must reconnect from the chat.
 */
export class RuntimeMcpOauthProvider implements OAuthClientProvider {
  private cached?: IMcpOauthBundle
  private verifier?: string
  private lastMarked = 0

  constructor(
    private readonly key: string,
    private readonly secrets: ISecretStore,
  ) {}

  /** The secret this provider reads and rotates. */
  get secretKey(): string {
    return this.key
  }

  private async load(): Promise<IMcpOauthBundle | undefined> {
    if (this.cached) return this.cached
    const raw = await this.secrets.get(this.key)
    if (!raw) return undefined
    try {
      this.cached = JSON.parse(raw) as IMcpOauthBundle
      return this.cached
    } catch (err) {
      log.warn(`oauth: bad token bundle at ${this.key} — ${(err as Error).message}`)
      return undefined
    }
  }

  /** Who this bundle belongs to, for "connected as …" in the chat. */
  async identity(): Promise<{ subject?: string; email?: string } | undefined> {
    const b = await this.load()
    if (!b) return undefined
    return { ...(b.subject ? { subject: b.subject } : {}), ...(b.email ? { email: b.email } : {}) }
  }

  /**
   * Record that the token was used (CLEAN-80). Ranch drops per-browser
   * bundles nobody used for a month; a person's own is never swept, so for
   * them this is just bookkeeping. Throttled and best-effort.
   */
  async markUsed(now = Date.now()): Promise<void> {
    if (now - this.lastMarked < USED_MARK_INTERVAL_MS) return
    const b = await this.load()
    if (!b) return
    this.lastMarked = now
    this.cached = { ...b, lastUsedAt: now }
    try {
      await this.secrets.set(this.key, JSON.stringify(this.cached))
    } catch (err) {
      log.debug(`oauth: could not mark ${this.key} used — ${(err as Error).message}`)
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
    const now = Date.now()
    const next: IMcpOauthBundle = {
      clientId: prev.clientId ?? "",
      issuer: prev.issuer ?? "",
      authorizationEndpoint: prev.authorizationEndpoint ?? "",
      tokenEndpoint: prev.tokenEndpoint ?? "",
      revocationEndpoint: prev.revocationEndpoint ?? null,
      accessToken: tokens.access_token,
      // Preserve the existing refresh token when the server doesn't rotate.
      refreshToken: tokens.refresh_token ?? prev.refreshToken ?? null,
      expiresAt:
        tokens.expires_in != null
          ? now + tokens.expires_in * 1000
          : (prev.expiresAt ?? null),
      scope: tokens.scope ?? prev.scope ?? null,
      ...(prev.subject ? { subject: prev.subject } : {}),
      ...(prev.email ? { email: prev.email } : {}),
      ...(prev.connectedAt ? { connectedAt: prev.connectedAt } : {}),
      // A refresh is a use.
      lastUsedAt: now,
    }
    this.cached = next
    this.lastMarked = now
    await this.secrets.set(this.key, JSON.stringify(next))
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
