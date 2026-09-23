import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { z } from "zod"
import type { Tool, ToolContext } from "../../../agent/tool"
import { IMcpGateway, type IMcpReconnectResult } from "../domain/mcp.gateway"
import type { IMcpServerConfig } from "../domain/mcp.types"
import {
  RuntimeMcpOauthProvider,
  mcpOauthSecretKey,
  resolveBundleKey,
  subjectOfSecretKey,
  type ISecretStore,
} from "./mcpOauth.provider"
import { createLogger } from "../../logger"

const log = createLogger("mcp")

const CLIENT_INFO = { name: "cleanslice-runtime", version: "1.0.0" }

/** A per-person OAuth client nobody used for this long is closed. */
const IDLE_CLIENT_MS = 30 * 60 * 1000
const IDLE_SWEEP_MS = 5 * 60 * 1000

interface IListedTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** One person's live connection to an OAuth server. */
interface IOauthClient {
  client: Client
  provider: RuntimeMcpOauthProvider
  lastUsed: number
}

/**
 * Everything the gateway keeps about an OAuth server (CLEAN-81). Unlike a
 * bearer/none server, which is one client for the whole agent, an OAuth
 * server is one client per person: the token is theirs, so the cart, the
 * orders and the loyalty balance are theirs too. Tools are listed once
 * (from whichever bundle connected first — the list does not depend on who
 * asks) and each call resolves the caller's own client lazily.
 */
interface IOauthServer {
  cfg: IMcpServerConfig & { id: string }
  /** Descriptors from tools/list, or null until any bundle could ask. */
  listed: IListedTool[] | null
  /** Open clients by subject. */
  clients: Map<string, IOauthClient>
}

/**
 * Who a tool call is for (CLEAN-80/81): the console login the hub attached
 * to the message, else the channel identity — which on Telegram is already
 * the person, and on a share link or an anonymous widget is the browser.
 */
export function subjectOf(ctx: Pick<ToolContext, "from" | "user">): string | undefined {
  return ctx.user?.id ?? ctx.from
}

/**
 * Concrete implementation: opens a real MCP client over the configured
 * transport, queries `tools/list`, and adapts each MCP tool into the runtime
 * `Tool` shape so it lives alongside built-in tools in ToolGateway.
 */
export class McpGateway extends IMcpGateway {
  private clients = new Map<string, Client>()
  private oauth = new Map<string, IOauthServer>()
  private idleSweeper: ReturnType<typeof setInterval> | null = null

  /**
   * @param secrets per-agent secret store — required for `oauth` MCP servers
   * (the runtime reads/refreshes their token bundle). Optional so non-OAuth
   * setups wire the gateway with no dependency.
   */
  constructor(private readonly secrets?: ISecretStore) {
    super()
  }

  async connect(cfg: IMcpServerConfig): Promise<Tool[]> {
    if (cfg.enabled === false) {
      log.info(`${cfg.name}: disabled, skipping`)
      return []
    }
    if (cfg.authType === "oauth") return this.connectOauth(cfg)

    let transport: Transport
    try {
      transport = this.buildTransport(cfg)
    } catch (err) {
      log.warn(`${cfg.name}: bad transport config — ${(err as Error).message}`)
      return []
    }

    const client = new Client(CLIENT_INFO)
    try {
      await client.connect(transport)
    } catch (err) {
      log.warn(`${cfg.name}: connect failed — ${(err as Error).message}`)
      return []
    }
    this.clients.set(cfg.name, client)

    let listed: IListedTool[]
    try {
      listed = await this.listTools(client)
    } catch (err) {
      log.warn(`${cfg.name}: tools/list failed — ${(err as Error).message}`)
      return []
    }

    const wrapped = listed.map((t) => this.wrapTool(cfg.name, () => Promise.resolve(client), t))
    log.info(`${cfg.name}: registered ${wrapped.length} tools`)
    return wrapped
  }

  /**
   * OAuth servers (CLEAN-75, per person since CLEAN-81): always expose the
   * `${name}__connect` tool, and the real tools as soon as ANY stored bundle
   * can list them — the agent-wide one, or the first person who connected.
   * With no bundle at all the connect tool is the whole surface until a
   * login lands and `reconnect` swaps the real tools in.
   */
  private async connectOauth(cfg: IMcpServerConfig): Promise<Tool[]> {
    if (!cfg.id || !this.secrets) {
      log.warn(`${cfg.name}: oauth server missing id or secret store`)
      return []
    }
    const server: IOauthServer = {
      cfg: { ...cfg, id: cfg.id },
      listed: null,
      clients: new Map(),
    }
    this.oauth.set(cfg.id, server)
    this.armIdleSweep()

    const seed = await this.anyBundleSubject(cfg.id)
    if (seed === undefined) {
      log.info(`${cfg.name}: oauth not connected — offering connect tool`)
      return [this.makeConnectTool(server)]
    }
    const listed = await this.listWithSubject(server, seed)
    if (!listed) return [this.makeConnectTool(server)]
    return this.oauthTools(server)
  }

  /**
   * A login just landed for `subject` (hub `mcp_connected`, CLEAN-79). Open
   * their client now and, if this server's tools were never listed, list
   * them and hand back the full tool set so the registry can swap the
   * connect-only surface for the real one. Null when this pod does not run
   * that server.
   */
  async reconnect(serverId: string, subject: string): Promise<IMcpReconnectResult | null> {
    const server = this.oauth.get(serverId)
    if (!server) return null
    // A fresh token replaces whatever client this subject had — the old one
    // may be holding a dead refresh.
    await this.evict(server, subject)
    const hadTools = server.listed !== null
    const client = await this.clientFor(server, subject)
    if (!client) {
      log.warn(`${server.cfg.name}: mcp_connected for ${subject} but no bundle found`)
      return { serverName: server.cfg.name, tools: null }
    }
    if (hadTools) {
      log.info(`${server.cfg.name}: ${subject} connected`)
      return { serverName: server.cfg.name, tools: null }
    }
    const listed = await this.listWithSubject(server, subject)
    if (!listed) return { serverName: server.cfg.name, tools: null }
    const tools = this.oauthTools(server)
    log.info(`${server.cfg.name}: ${subject} connected — ${tools.length - 1} tools now live`)
    return { serverName: server.cfg.name, tools }
  }

  async closeAll(): Promise<void> {
    if (this.idleSweeper) clearInterval(this.idleSweeper)
    this.idleSweeper = null
    const closes: Promise<void>[] = []
    for (const c of this.clients.values()) {
      closes.push(c.close().catch((err) => log.warn("close error", err)))
    }
    for (const server of this.oauth.values()) {
      for (const entry of server.clients.values()) {
        closes.push(entry.client.close().catch((err) => log.warn("close error", err)))
      }
      server.clients.clear()
    }
    await Promise.all(closes)
    this.clients.clear()
  }

  // ── OAuth internals ─────────────────────────────────────────────

  /** The connect tool plus one wrapped tool per listed descriptor. */
  private oauthTools(server: IOauthServer): Tool[] {
    const wrapped = (server.listed ?? []).map((t) =>
      this.wrapTool(server.cfg.name, (ctx) => this.clientForCall(server, ctx), t, server),
    )
    return [this.makeConnectTool(server), ...wrapped]
  }

  /** tools/list through `subject`'s client; records the descriptors. */
  private async listWithSubject(server: IOauthServer, subject: string): Promise<IListedTool[] | null> {
    const client = await this.clientFor(server, subject)
    if (!client) return null
    try {
      server.listed = await this.listTools(client)
      log.info(`${server.cfg.name}: listed ${server.listed.length} tools via ${subject}`)
      return server.listed
    } catch (err) {
      log.warn(`${server.cfg.name}: tools/list failed — ${(err as Error).message}`)
      await this.evict(server, subject)
      return null
    }
  }

  /**
   * Some subject that already holds a bundle for this server, to list tools
   * with at boot: the agent-wide one is tried first (it is the bundle a
   * Connect from the Rancher chat wrote), then whoever connected personally.
   */
  private async anyBundleSubject(serverId: string): Promise<string | undefined> {
    if (!this.secrets) return undefined
    if (await this.secrets.get(mcpOauthSecretKey(serverId))) return serverId
    if (!this.secrets.list) return undefined
    try {
      for (const name of await this.secrets.list()) {
        const subject = subjectOfSecretKey(serverId, name)
        if (subject) return subject
      }
    } catch (err) {
      log.debug(`secret listing failed — ${(err as Error).message}`)
    }
    return undefined
  }

  /** The client for a tool call: the caller's subject, or nothing usable. */
  private async clientForCall(server: IOauthServer, ctx: ToolContext): Promise<Client | null> {
    const subject = subjectOf(ctx) ?? server.cfg.id
    return this.clientFor(server, subject)
  }

  /**
   * Open (or reuse) `subject`'s client. Their own bundle first, then the
   * agent-wide one; null when neither exists — the tool then points at
   * `${name}__connect`.
   */
  private async clientFor(server: IOauthServer, subject: string): Promise<Client | null> {
    const cached = server.clients.get(subject)
    if (cached) {
      cached.lastUsed = Date.now()
      return cached.client
    }
    if (!this.secrets || !server.cfg.url) return null
    const key = await resolveBundleKey(this.secrets, server.cfg.id, subject)
    if (!key) return null

    const provider = new RuntimeMcpOauthProvider(key, this.secrets)
    const transport = this.buildOauthTransport(server.cfg, provider)
    const client = new Client(CLIENT_INFO)
    try {
      await client.connect(transport)
    } catch (err) {
      log.warn(`${server.cfg.name}: connect for ${subject} failed — ${(err as Error).message}`)
      return null
    }
    server.clients.set(subject, { client, provider, lastUsed: Date.now() })
    void provider.markUsed()
    return client
  }

  private async evict(server: IOauthServer, subject: string): Promise<void> {
    const entry = server.clients.get(subject)
    if (!entry) return
    server.clients.delete(subject)
    await entry.client.close().catch(() => undefined)
  }

  private armIdleSweep(): void {
    if (this.idleSweeper) return
    this.idleSweeper = setInterval(() => {
      const cutoff = Date.now() - IDLE_CLIENT_MS
      for (const server of this.oauth.values()) {
        for (const [subject, entry] of server.clients) {
          if (entry.lastUsed < cutoff) void this.evict(server, subject)
        }
      }
    }, IDLE_SWEEP_MS)
    this.idleSweeper.unref?.()
  }

  /**
   * Synthetic tool offered for an OAuth MCP: connect the calling person, or
   * say who they are connected as. Calling it asks ranch to start the OAuth
   * handshake for THIS subject and returns a login URL for the agent to hand
   * them. After they finish, ranch pushes `mcp_connected` and `reconnect`
   * brings their client up in this session.
   */
  private makeConnectTool(server: IOauthServer): Tool {
    const { cfg } = server
    return {
      name: `${cfg.name}__connect`,
      description:
        `Connect the "${cfg.name}" service for the person you are talking to, or ` +
        `check whether they are connected. Call it when they want to use ` +
        `${cfg.name} and a ${cfg.name} tool answered that they are not connected, ` +
        `or when they ask what account is linked. Returns either "connected as …" ` +
        `or a login link — send the link to them and ask them to open it and log ` +
        `in. Each person connects their own account; once they finish, ` +
        `${cfg.name}'s tools work for them.`,
      schema: z.object({}),
      inputSchema: { type: "object", properties: {} },
      execute: async (_params, ctx) => {
        const subject = subjectOf(ctx) ?? cfg.id
        if (this.secrets) {
          const key = await resolveBundleKey(this.secrets, cfg.id, subject)
          if (key) {
            const who = await new RuntimeMcpOauthProvider(key, this.secrets).identity()
            const shared = key === mcpOauthSecretKey(cfg.id)
            return {
              connected: true,
              as: who?.email ?? (shared ? "the agent's shared account" : subject),
              shared,
              message: shared
                ? `${cfg.name} is connected through the agent's shared account. Call this tool again only if the person wants to link their own account instead.`
                : `${cfg.name} is connected as ${who?.email ?? subject}.`,
            }
          }
        }
        const base = (process.env.RANCH_API_URL ?? process.env.API_URL)?.replace(/\/+$/, "")
        const key = process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY
        const agentId = process.env.AGENT_ID ?? process.env.BRIDLE_AGENT_ID
        if (!base || !key || !agentId) {
          return { error: "Connect unavailable (RANCH_API_URL / BRIDLE_API_KEY / AGENT_ID missing)" }
        }
        try {
          const res = await fetch(`${base}/mcp-servers/${cfg.id}/oauth/start`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bridle-api-key": key },
            body: JSON.stringify({
              agentId,
              subject,
              ...(ctx.user?.email ? { email: ctx.user.email } : {}),
            }),
          })
          if (!res.ok) {
            return { error: `Could not start connect (${res.status})` }
          }
          const body = (await res.json()) as { data?: { authorizeUrl?: string }; authorizeUrl?: string }
          const authorizeUrl = body.data?.authorizeUrl ?? body.authorizeUrl
          if (!authorizeUrl) return { error: "Connect start returned no URL" }
          return {
            authorizeUrl,
            instructions: `Send the person this link and ask them to open it and log in to connect ${cfg.name} to their own account. Tell them to return to the chat when done; ${cfg.name}'s tools will work for them right away.`,
          }
        } catch (err) {
          return { error: `Connect failed: ${(err as Error).message}` }
        }
      },
    }
  }

  // ── Shared ──────────────────────────────────────────────────────

  private async listTools(client: Client): Promise<IListedTool[]> {
    const listed = (await client.listTools()) as { tools: IListedTool[] }
    return listed.tools
  }

  /**
   * Wraps a remote MCP tool as a runtime Tool. Uses `z.any()` for the Zod
   * schema (the MCP server validates params on its side) and exposes the
   * MCP `inputSchema` directly via `Tool.inputSchema` so the LLM gets the
   * real param contract — `tool.module.toAnthropicTools()` and the LLM
   * repositories prefer `inputSchema` over `zodToJsonSchema(schema)`.
   *
   * `resolve` picks the client per call — the one shared client for a
   * bearer/none server, the caller's own for an OAuth server.
   */
  private wrapTool(
    serverName: string,
    resolve: (ctx: ToolContext) => Promise<Client | null>,
    mcpTool: IListedTool,
    oauthServer?: IOauthServer,
  ): Tool {
    return {
      name: `${serverName}__${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${serverName}`,
      schema: z.any(),
      inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
      execute: async (params, ctx) => {
        const client = await resolve(ctx)
        if (!client) {
          return {
            error: `${serverName} is not connected for this person.`,
            next: `Call ${serverName}__connect to give them a login link.`,
          }
        }
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          })
          if (oauthServer) {
            const subject = subjectOf(ctx) ?? oauthServer.cfg.id
            void oauthServer.clients.get(subject)?.provider.markUsed()
          }
          // MCP returns a `content` array. Hand it back as-is — the LLM cycle
          // serializes whatever we return to JSON before the next turn.
          return result.content ?? result
        } catch (err) {
          const message = (err as Error).message ?? String(err)
          // A dead refresh token surfaces as the SDK's UnauthorizedError (or
          // our own redirectToAuthorization message). Drop the client so the
          // next call does not keep failing, and point at the connect tool.
          if (oauthServer && isAuthFailure(err)) {
            const subject = subjectOf(ctx) ?? oauthServer.cfg.id
            await this.evict(oauthServer, subject)
            return {
              error: `${serverName}'s login for this person has expired or was revoked.`,
              next: `Call ${serverName}__connect to give them a fresh login link.`,
            }
          }
          return { error: `MCP ${serverName}.${mcpTool.name} failed: ${message}` }
        }
      },
    }
  }

  private buildOauthTransport(cfg: IMcpServerConfig, provider: RuntimeMcpOauthProvider): Transport {
    if (!cfg.url) throw new Error("url required for oauth transport")
    if (cfg.transport === "sse") {
      return new SSEClientTransport(new URL(cfg.url), { authProvider: provider })
    }
    // OAuth servers carry no static header — the SDK's authProvider attaches
    // the bearer and refreshes it on 401 from the stored refresh token.
    return new StreamableHTTPClientTransport(new URL(cfg.url), { authProvider: provider })
  }

  private buildTransport(cfg: IMcpServerConfig): Transport {
    const headers = this.buildAuthHeaders(cfg)

    if (cfg.transport === "streamableHttp") {
      if (!cfg.url) throw new Error("url required for streamableHttp transport")
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers },
      })
    }
    if (cfg.transport === "sse") {
      if (!cfg.url) throw new Error("url required for sse transport")
      return new SSEClientTransport(new URL(cfg.url), {
        requestInit: { headers },
      })
    }
    if (cfg.transport === "stdio") {
      if (!cfg.command) throw new Error("command required for stdio transport")
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
      })
    }
    throw new Error(`unsupported transport: ${cfg.transport}`)
  }

  private buildAuthHeaders(cfg: IMcpServerConfig): Record<string, string> {
    if (!cfg.authValue || cfg.authType === "none" || !cfg.authType) return {}
    if (cfg.authType === "bearer") {
      return { Authorization: `Bearer ${cfg.authValue}` }
    }
    if (cfg.authType === "header") {
      // Format: "Header-Name: value" — split on first colon.
      const idx = cfg.authValue.indexOf(":")
      if (idx === -1) return {}
      const name = cfg.authValue.slice(0, idx).trim()
      const value = cfg.authValue.slice(idx + 1).trim()
      return { [name]: value }
    }
    return {}
  }
}

/** The SDK's own auth failure, or our provider refusing to re-authorize. */
export function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "UnauthorizedError") return true
  const code = (err as { code?: unknown }).code
  if (code === 401 || code === 403) return true
  return /reconnect from the chat|unauthorized|401/i.test(err.message)
}
