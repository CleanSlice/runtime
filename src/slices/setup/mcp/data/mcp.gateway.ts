import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { z } from "zod"
import type { Tool, ToolContext } from "../../../agent/tool"
import { IMcpGateway, type IMcpReconnectResult } from "../domain/mcp.gateway"
import type { IMcpServerConfig } from "../domain/mcp.types"
import { ACTOR_META_KEY, actorLabel, type IActor } from "../domain/actor"
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
  /** MCP tool annotations; `readOnlyHint` is the only one the runtime reads. */
  annotations?: { readOnlyHint?: boolean }
}

/** How long one actor's catalogue is trusted before Ranch is asked again (CLEAN-232). */
export const CATALOGUE_TTL_MS = 60 * 1000
/** Most actors a server's catalogue cache holds; the oldest goes first. */
const CATALOGUE_MAX_ACTORS = 200

/** The slice of the SDK client the gateway uses; `open` returns one. */
export type IMcpClient = Pick<Client, "listTools" | "callTool" | "close">

/** One actor's catalogue: the wrapped tools Ranch listed for them, and when. */
interface ICatalogue {
  at: number
  tools: Promise<Tool[]>
}

/**
 * A bearer/header/none server: one client for the whole agent. The client
 * is replaceable, because the server may forget the session (CLEAN-232, R17).
 */
interface IStaticServer {
  cfg: IMcpServerConfig
  client: IMcpClient
  /** A reconnect in flight, shared by every call that found the session gone. */
  reopening: Promise<IMcpClient> | null
  /**
   * This is Ranch's own server: the agent authenticates to it with its own
   * Ranch token. Only such a server is told who a call is for, and only its
   * tools are listed per actor.
   */
  ranch: boolean
  /** One wrapper per tool name, so the registry and every catalogue hold the same object. */
  wrappers: Map<string, Tool>
  /** Catalogues by actor (`actorKey`). Ranch servers only. */
  catalogues: Map<string, ICatalogue>
}

/** The server forgot the session and a fresh one could not be opened, or failed the same way. */
class McpUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`unavailable: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = "McpUnavailableError"
  }
}

const GUEST: IActor = { kind: "guest" }

/**
 * Cache key of an actor. It holds the token, because two people are two
 * catalogues; it is never logged (`actorLabel` is what logs print).
 */
function actorKey(actor: IActor): string {
  if (actor.kind === "person") return `person:${actor.token}`
  if (actor.kind === "trusted") return `trusted:${actor.via}`
  return "guest"
}

/**
 * Whether a server is Ranch's own (CLEAN-232): it is the one the agent
 * signs in to with `RANCH_API_TOKEN`, which Ranch writes into the bearer of
 * its built-in servers when it deploys the pod. The acting token of a
 * person goes where the agent's own token already goes, and nowhere else:
 * not to a server with another credential, and never to an OAuth server.
 */
export function isRanchServer(cfg: IMcpServerConfig, ranchToken = process.env.RANCH_API_TOKEN): boolean {
  if (cfg.authType !== "bearer") return false
  const token = ranchToken?.trim()
  return !!token && cfg.authValue?.trim() === token
}

/**
 * The server no longer knows the session this client holds (CLEAN-232, R17).
 * Ranch keeps MCP sessions in memory, so every API restart answers the next
 * request with HTTP 404 and a JSON-RPC body `-32000 "Session not found"`.
 * The SDK's `StreamableHTTPClientTransport.send` turns a non-OK POST into
 * `StreamableHTTPError(response.status, "Error POSTing to endpoint: <body>")`,
 * so the status is on `code` and the body's words are in `message`; the SSE
 * transport puts `(HTTP 404)` in the message instead.
 */
export function isLostSession(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if ((err as { code?: unknown }).code === 404) return true
  return /session not found|\(HTTP 404\)/i.test(err.message)
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
  /**
   * Subjects whose stored bundle the provider refused (revoked grant, dead
   * refresh). Their calls and the connect tool point at a fresh login until
   * `reconnect` clears the mark — otherwise the bundle on disk keeps saying
   * "connected" while every call fails.
   */
  dead: Set<string>
}

/**
 * Who a tool call is for (CLEAN-80/81): the console login the hub attached
 * to the message, else the channel identity — which on Telegram is already
 * the person, and on a share link or an anonymous widget is the browser.
 */
/**
 * Where the OAuth callback page should send the person afterwards
 * (CLEAN-120): the chat with this agent in the console they came from.
 * Only for a signed-in person on a known origin — a share visitor or an
 * anonymous widget has no console page to go back to, and ranch would
 * refuse an origin it does not own anyway.
 */
export function returnToFor(ctx: Pick<ToolContext, "user" | "origin">, agentId: string): string | undefined {
  if (!ctx.user?.id || !ctx.origin) return undefined
  return `${ctx.origin}/agents/${encodeURIComponent(agentId)}`
}

export function subjectOf(ctx: Pick<ToolContext, "from" | "user">): string | undefined {
  return ctx.user?.id ?? ctx.from
}

/**
 * Concrete implementation: opens a real MCP client over the configured
 * transport, queries `tools/list`, and adapts each MCP tool into the runtime
 * `Tool` shape so it lives alongside built-in tools in ToolGateway.
 */
export class McpGateway extends IMcpGateway {
  private statics = new Map<string, IStaticServer>()
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

    let client: IMcpClient
    try {
      client = await this.open(cfg)
    } catch (err) {
      log.warn(`${cfg.name}: connect failed — ${(err as Error).message}`)
      return []
    }
    const server: IStaticServer = {
      cfg,
      client,
      reopening: null,
      ranch: isRanchServer(cfg),
      wrappers: new Map(),
      catalogues: new Map(),
    }
    this.statics.set(cfg.name, server)

    // The registry is filled as the agent itself: at boot nobody is asking.
    // What a turn is offered is listed again for its own actor (`scopeTools`).
    const self: IActor = { kind: "trusted", via: "internal" }
    let wrapped: Tool[]
    try {
      wrapped = server.ranch ? await this.catalogueFor(server, self) : await this.listStatic(server)
    } catch (err) {
      log.warn(`${cfg.name}: tools/list failed — ${(err as Error).message}`)
      return []
    }
    log.info(`${cfg.name}: registered ${wrapped.length} tools${server.ranch ? " (listed per caller)" : ""}`)
    return wrapped
  }

  /**
   * One turn's tools (CLEAN-232). For every server that lists per caller —
   * Ranch's own — the tools of that server in `tools` are replaced by what
   * it lists for `actor`, asked once and kept for a minute. The order of
   * `tools` is kept and anything new goes to the end, so against a Ranch
   * that lists the same for everyone the result is `tools` itself. If the
   * server cannot be asked, the turn gets none of its tools: offering all of
   * them would be the old behaviour this exists to end.
   *
   * Built-in tools and every other MCP server pass through untouched.
   */
  async scopeTools(tools: Tool[], actor: IActor): Promise<Tool[]> {
    let out = tools
    for (const server of this.statics.values()) {
      if (!server.ranch) continue
      const prefix = `${server.cfg.name}__`
      let own: Tool[]
      try {
        own = await this.catalogueFor(server, actor)
      } catch (err) {
        log.warn(`${server.cfg.name}: tools/list for ${actorLabel(actor)} failed, offering none of its tools this turn — ${(err as Error).message}`)
        own = []
      }
      const allowed = new Set(own)
      const seen = new Set<Tool>()
      const next: Tool[] = []
      for (const tool of out) {
        if (!tool.name.startsWith(prefix)) {
          next.push(tool)
        } else if (allowed.has(tool)) {
          next.push(tool)
          seen.add(tool)
        }
      }
      for (const tool of own) {
        if (!seen.has(tool)) next.push(tool)
      }
      out = next
    }
    return out
  }

  // ── Static (bearer/header/none) internals ───────────────────────

  /**
   * Opens a client for a static server: transport, client, `initialize`.
   * Its own method so a reconnect and the first connect are the same act,
   * and so a spec can hand the gateway a client without a network.
   */
  protected async open(cfg: IMcpServerConfig): Promise<IMcpClient> {
    const transport = this.buildTransport(cfg)
    const client = new Client(CLIENT_INFO)
    await client.connect(transport)
    return client
  }

  /**
   * Runs one request on the server's client. When the server answers that
   * it does not know the session (CLEAN-232, R17), the client is dropped, a
   * new one is opened and the request is sent once more. A second failure
   * of either step is `McpUnavailableError`; any other error passes through
   * as it came.
   */
  private async withSession<T>(server: IStaticServer, run: (client: IMcpClient) => Promise<T>): Promise<T> {
    const client = server.client
    try {
      return await run(client)
    } catch (err) {
      if (!isLostSession(err)) throw err
      log.warn(`${server.cfg.name}: the server no longer knows this session — reconnecting`)
    }
    try {
      return await run(await this.reopen(server, client))
    } catch (err) {
      log.warn(`${server.cfg.name}: still failing after a reconnect — ${(err as Error).message}`)
      throw new McpUnavailableError(err)
    }
  }

  /** Replace `stale` with a fresh client; concurrent callers share one reconnect. */
  private reopen(server: IStaticServer, stale: IMcpClient): Promise<IMcpClient> {
    // Somebody else already replaced it while this call was failing.
    if (server.client !== stale) return Promise.resolve(server.client)
    if (server.reopening) return server.reopening
    const reopening = (async () => {
      await stale.close().catch(() => undefined)
      const fresh = await this.open(server.cfg)
      server.client = fresh
      log.info(`${server.cfg.name}: reconnected`)
      return fresh
    })().finally(() => {
      server.reopening = null
    })
    server.reopening = reopening
    return reopening
  }

  /** The tools of a server that lists the same for everyone. */
  private async listStatic(server: IStaticServer): Promise<Tool[]> {
    const listed = await this.withSession(server, (client) => this.listTools(client))
    return listed.map((t) => this.staticTool(server, t))
  }

  /**
   * What a Ranch server lists for `actor`, wrapped. One `tools/list` per
   * actor per minute: concurrent askers share the request, a failure is not
   * kept, and the cache is swept and capped so tokens do not pile up in it.
   */
  private catalogueFor(server: IStaticServer, actor: IActor): Promise<Tool[]> {
    const key = actorKey(actor)
    const now = Date.now()
    const hit = server.catalogues.get(key)
    if (hit && now - hit.at < CATALOGUE_TTL_MS) return hit.tools

    for (const [k, entry] of server.catalogues) {
      if (now - entry.at >= CATALOGUE_TTL_MS) server.catalogues.delete(k)
    }
    while (server.catalogues.size >= CATALOGUE_MAX_ACTORS) {
      const oldest = server.catalogues.keys().next().value
      if (oldest === undefined) break
      server.catalogues.delete(oldest)
    }

    const entry: ICatalogue = {
      at: now,
      tools: this.withSession(server, (client) => this.listTools(client, actor)).then((listed) =>
        listed.map((t) => this.staticTool(server, t)),
      ),
    }
    server.catalogues.set(key, entry)
    entry.tools.catch(() => {
      if (server.catalogues.get(key) === entry) server.catalogues.delete(key)
    })
    return entry.tools
  }

  /** The wrapper for one listed tool; the same object every time it is listed. */
  private staticTool(server: IStaticServer, mcpTool: IListedTool): Tool {
    const known = server.wrappers.get(mcpTool.name)
    if (known) return known
    const serverName = server.cfg.name
    const tool: Tool = {
      ...this.describeTool(serverName, mcpTool),
      execute: async (params, ctx) => {
        // The actor comes from the runtime's context, never from `params`.
        const actor = ctx.actor ?? GUEST
        try {
          if (server.ranch) {
            // The model can name a tool it was not offered. Ranch would
            // refuse it; the runtime does not send it at all.
            const catalogue = await this.catalogueFor(server, actor)
            if (!catalogue.includes(tool)) {
              log.warn(`${tool.name}: not in the catalogue of ${actorLabel(actor)}, not called`)
              return { error: `"${tool.name}" is not available to this person.` }
            }
          }
          const result = await this.withSession(server, (client) =>
            client.callTool({
              name: mcpTool.name,
              arguments: (params ?? {}) as Record<string, unknown>,
              ...(server.ranch ? { _meta: { [ACTOR_META_KEY]: actor } } : {}),
            }),
          )
          // MCP returns a `content` array. Hand it back as-is — the LLM cycle
          // serializes whatever we return to JSON before the next turn.
          return result.content ?? result
        } catch (err) {
          // Nothing to suggest: there is no other route to this server, and
          // the model must not go looking for one.
          if (err instanceof McpUnavailableError) return { error: `${serverName} is not reachable right now.` }
          const message = (err as Error).message ?? String(err)
          return { error: `MCP ${serverName}.${mcpTool.name} failed: ${message}` }
        }
      },
    }
    server.wrappers.set(mcpTool.name, tool)
    return tool
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
      dead: new Set(),
    }
    this.oauth.set(cfg.id, server)
    this.armIdleSweep()

    const seeds = await this.bundleSubjects(cfg.id)
    if (seeds.length === 0) {
      log.info(`${cfg.name}: oauth not connected — offering connect tool`)
      return [this.makeConnectTool(server)]
    }
    // Any live bundle will do for the listing; one whose grant died (seen
    // live: a newer login with the same account replaced it) is skipped, not
    // the end of it — the next person's bundle lists the tools just as well.
    for (const seed of seeds) {
      if (await this.listWithSubject(server, seed)) return this.oauthTools(server)
    }
    log.info(`${cfg.name}: no stored login could list tools — offering connect tool`)
    return [this.makeConnectTool(server)]
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
    server.dead.delete(subject)
    const hadTools = server.listed !== null
    const client = await this.clientFor(server, subject)
    if (!client) {
      // Two different failures used to share one line (CLEAN-122): the
      // bundle really missing, and a bundle the provider refused to open —
      // that one was already logged by clientFor, so say so instead of
      // sending the reader to look for a secret that is there.
      const stored = this.secrets
        ? await resolveBundleKey(this.secrets, server.cfg.id, subject)
        : null
      log.warn(
        stored
          ? `${server.cfg.name}: mcp_connected for ${subject} but the stored login could not be opened (see the connect error above)`
          : `${server.cfg.name}: mcp_connected for ${subject} but no bundle found`,
      )
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
    for (const server of this.statics.values()) {
      closes.push(server.client.close().catch((err) => log.warn("close error", err)))
    }
    for (const server of this.oauth.values()) {
      for (const entry of server.clients.values()) {
        closes.push(entry.client.close().catch((err) => log.warn("close error", err)))
      }
      server.clients.clear()
    }
    await Promise.all(closes)
    this.statics.clear()
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
      if (isAuthFailure(err)) server.dead.add(subject)
      return null
    }
  }

  /**
   * Some subject that already holds a bundle for this server, to list tools
   * with at boot: the agent-wide one is tried first (it is the bundle a
   * Connect from the Rancher chat wrote), then whoever connected personally.
   */
  private async bundleSubjects(serverId: string): Promise<string[]> {
    if (!this.secrets) return []
    const out: string[] = []
    if (await this.secrets.get(mcpOauthSecretKey(serverId))) out.push(serverId)
    if (!this.secrets.list) return out
    try {
      for (const name of await this.secrets.list()) {
        const subject = subjectOfSecretKey(serverId, name)
        if (subject) out.push(subject)
      }
    } catch (err) {
      log.debug(`secret listing failed — ${(err as Error).message}`)
    }
    return out
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
    if (server.dead.has(subject)) return null
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
      // A refused login is not a network hiccup: stop retrying the bundle
      // and let the connect tool hand out a fresh link.
      if (isAuthFailure(err)) server.dead.add(subject)
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
      effect: "write",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {} },
      execute: async (_params, ctx) => {
        const subject = subjectOf(ctx) ?? cfg.id
        // A bundle the provider already refused is not "connected", whatever
        // the disk says: hand out a fresh link instead.
        if (this.secrets && !server.dead.has(subject)) {
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
        const returnTo = returnToFor(ctx, agentId)
        try {
          const res = await fetch(`${base}/mcp-servers/${cfg.id}/oauth/start`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bridle-api-key": key },
            body: JSON.stringify({
              agentId,
              subject,
              ...(ctx.user?.email ? { email: ctx.user.email } : {}),
              ...(returnTo ? { returnTo } : {}),
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
            instructions: returnTo
              ? `Send the person this link and ask them to open it and log in to connect ${cfg.name} to their own account. The page brings them back to this chat on its own when they are done; ${cfg.name}'s tools will work for them right away.`
              : `Send the person this link and ask them to open it and log in to connect ${cfg.name} to their own account. Tell them to return to the chat when done; ${cfg.name}'s tools will work for them right away.`,
          }
        } catch (err) {
          return { error: `Connect failed: ${(err as Error).message}` }
        }
      },
    }
  }

  // ── Shared ──────────────────────────────────────────────────────

  /** `tools/list`; with `actor`, on behalf of that actor (Ranch's own server only). */
  private async listTools(client: IMcpClient, actor?: IActor): Promise<IListedTool[]> {
    const listed = (await client.listTools(
      actor ? { _meta: { [ACTOR_META_KEY]: actor } } : undefined,
    )) as { tools: IListedTool[] }
    return listed.tools
  }

  /** What every wrapped MCP tool has in common, whichever client calls it. */
  private describeTool(serverName: string, mcpTool: IListedTool): Omit<Tool, "execute"> {
    return {
      name: `${serverName}__${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${serverName}`,
      // Only a server that vouches for read-only gets `read`; the rest count
      // as mutating, which keeps them out of delegated workers (CLEAN-150).
      effect: mcpTool.annotations?.readOnlyHint === true ? "read" : "write",
      schema: z.any(),
      inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
    }
  }

  /**
   * Wraps a remote MCP tool as a runtime Tool. Uses `z.any()` for the Zod
   * schema (the MCP server validates params on its side) and exposes the
   * MCP `inputSchema` directly via `Tool.inputSchema` so the LLM gets the
   * real param contract — `tool.module.toAnthropicTools()` and the LLM
   * repositories prefer `inputSchema` over `zodToJsonSchema(schema)`.
   *
   * This is the OAuth half: `resolve` picks the caller's own client per
   * call. A bearer/none server's tools are wrapped by `staticTool`. An OAuth
   * server is never Ranch's own, so nothing here says who the call is for.
   */
  private wrapTool(
    serverName: string,
    resolve: (ctx: ToolContext) => Promise<Client | null>,
    mcpTool: IListedTool,
    oauthServer?: IOauthServer,
  ): Tool {
    return {
      ...this.describeTool(serverName, mcpTool),
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
            oauthServer.dead.add(subject)
            log.warn(`${serverName}: login for ${subject} refused — ${message}`)
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

/**
 * The SDK's own auth failure, our provider refusing to re-authorize, or the
 * provider's server saying the grant is gone. The last one arrives as an
 * ordinary tool error — Silpo answers "Grant not found" once a newer login
 * with the same account replaced this one (seen live) — so the message is
 * matched too, on the wordings OAuth servers use for a dead grant or token.
 */
export function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "UnauthorizedError") return true
  const code = (err as { code?: unknown }).code
  if (code === 401 || code === 403) return true
  return /reconnect from the chat|unauthori[sz]ed|\b401\b|invalid[_ ]grant|grant (not found|revoked|expired)|invalid[_ ]token|token (expired|revoked|not found)/i.test(
    err.message,
  )
}
