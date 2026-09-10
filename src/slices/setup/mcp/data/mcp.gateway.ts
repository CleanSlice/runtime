import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { z } from "zod"
import type { Tool } from "../../../agent/tool"
import { IMcpGateway } from "../domain/mcp.gateway"
import type { IMcpServerConfig } from "../domain/mcp.types"
import {
  RuntimeMcpOauthProvider,
  mcpOauthSecretKey,
  type ISecretStore,
} from "./mcpOauth.provider"
import { createLogger } from "../../logger"

const log = createLogger("mcp")

const CLIENT_INFO = { name: "cleanslice-runtime", version: "1.0.0" }

/**
 * Concrete implementation: opens a real MCP client over the configured
 * transport, queries `tools/list`, and adapts each MCP tool into the runtime
 * `Tool` shape so it lives alongside built-in tools in ToolGateway.
 */
export class McpGateway extends IMcpGateway {
  private clients = new Map<string, Client>()

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

    // OAuth servers: when the agent has no stored token yet, don't try to
    // connect — expose a `${name}__connect` tool the agent can call to hand
    // the user a login link (CLEAN-75). The real tools replace it once the
    // token lands. Any failure below (e.g. a dead refresh token) also falls
    // back to the connect tool so the user can re-authorize.
    const isOauth = cfg.authType === "oauth"
    const fallback = (): Tool[] => (isOauth ? [this.makeConnectTool(cfg)] : [])
    if (isOauth) {
      if (!cfg.id || !this.secrets) {
        log.warn(`${cfg.name}: oauth server missing id or secret store`)
        return []
      }
      const hasToken = Boolean(await this.secrets.get(mcpOauthSecretKey(cfg.id)))
      if (!hasToken) {
        log.info(`${cfg.name}: oauth not connected — offering connect tool`)
        return [this.makeConnectTool(cfg)]
      }
    }

    let transport: Transport
    try {
      transport = this.buildTransport(cfg)
    } catch (err) {
      log.warn(`${cfg.name}: bad transport config — ${(err as Error).message}`)
      return fallback()
    }

    const client = new Client(CLIENT_INFO)
    try {
      await client.connect(transport)
    } catch (err) {
      log.warn(`${cfg.name}: connect failed — ${(err as Error).message}`)
      return fallback()
    }
    this.clients.set(cfg.name, client)

    let listed: { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    try {
      listed = (await client.listTools()) as typeof listed
    } catch (err) {
      log.warn(`${cfg.name}: tools/list failed — ${(err as Error).message}`)
      return fallback()
    }

    const wrapped = listed.tools.map((t) => this.wrapTool(cfg.name, client, t))
    log.info(`${cfg.name}: registered ${wrapped.length} tools`)
    return wrapped
  }

  /**
   * Synthetic tool offered for an OAuth MCP the agent hasn't connected yet.
   * Calling it asks ranch to start the OAuth handshake and returns a login URL
   * for the agent to hand the user. After the user finishes, the real MCP
   * tools take its place (on the `mcp_connected` reload / next boot).
   */
  private makeConnectTool(cfg: IMcpServerConfig): Tool {
    const serverId = cfg.id as string
    return {
      name: `${cfg.name}__connect`,
      description:
        `Connect the "${cfg.name}" service. Call this when the user wants to use ` +
        `${cfg.name} but it isn't connected yet. Returns a link — send it to the ` +
        `user and ask them to open it and log in. Once they finish, ${cfg.name}'s ` +
        `tools become available.`,
      schema: z.object({}),
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const base = (process.env.RANCH_API_URL ?? process.env.API_URL)?.replace(/\/+$/, "")
        const key = process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY
        const agentId = process.env.AGENT_ID ?? process.env.BRIDLE_AGENT_ID
        if (!base || !key || !agentId) {
          return { error: "Connect unavailable (RANCH_API_URL / BRIDLE_API_KEY / AGENT_ID missing)" }
        }
        try {
          const res = await fetch(`${base}/mcp-servers/${serverId}/oauth/start`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bridle-api-key": key },
            body: JSON.stringify({ agentId }),
          })
          if (!res.ok) {
            return { error: `Could not start connect (${res.status})` }
          }
          const body = (await res.json()) as { data?: { authorizeUrl?: string }; authorizeUrl?: string }
          const authorizeUrl = body.data?.authorizeUrl ?? body.authorizeUrl
          if (!authorizeUrl) return { error: "Connect start returned no URL" }
          return {
            authorizeUrl,
            instructions: `Send the user this link and ask them to open it and log in to connect ${cfg.name}. Tell them to return to the chat when done.`,
          }
        } catch (err) {
          return { error: `Connect failed: ${(err as Error).message}` }
        }
      },
    }
  }

  async closeAll(): Promise<void> {
    const closes = [...this.clients.values()].map((c) =>
      c.close().catch((err) => log.warn("close error", err)),
    )
    await Promise.all(closes)
    this.clients.clear()
  }

  /**
   * Wraps a remote MCP tool as a runtime Tool. Uses `z.any()` for the Zod
   * schema (the MCP server validates params on its side) and exposes the
   * MCP `inputSchema` directly via `Tool.inputSchema` so the LLM gets the
   * real param contract — `tool.module.toAnthropicTools()` and the LLM
   * repositories prefer `inputSchema` over `zodToJsonSchema(schema)`.
   */
  private wrapTool(
    serverName: string,
    client: Client,
    mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  ): Tool {
    return {
      name: `${serverName}__${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${serverName}`,
      schema: z.any(),
      inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
      execute: async (params) => {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          })
          // MCP returns a `content` array. Hand it back as-is — the LLM cycle
          // serializes whatever we return to JSON before the next turn.
          return result.content ?? result
        } catch (err) {
          return { error: `MCP ${serverName}.${mcpTool.name} failed: ${(err as Error).message}` }
        }
      },
    }
  }

  private buildTransport(cfg: IMcpServerConfig): Transport {
    const headers = this.buildAuthHeaders(cfg)

    if (cfg.transport === "streamableHttp") {
      if (!cfg.url) throw new Error("url required for streamableHttp transport")
      // OAuth servers carry no static header — the SDK's authProvider attaches
      // the bearer and refreshes it on 401 from the stored refresh token.
      if (cfg.authType === "oauth") {
        if (!cfg.id) throw new Error("oauth MCP server missing id")
        if (!this.secrets) throw new Error("oauth MCP server requires a secret store")
        return new StreamableHTTPClientTransport(new URL(cfg.url), {
          authProvider: new RuntimeMcpOauthProvider(cfg.id, this.secrets),
        })
      }
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
