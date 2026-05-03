import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { z } from "zod"
import type { Tool } from "../../../agent/tool"
import { IMcpGateway } from "../domain/mcp.gateway"
import type { IMcpServerConfig } from "../domain/mcp.types"

const CLIENT_INFO = { name: "cleanslice-runtime", version: "1.0.0" }

/**
 * Concrete implementation: opens a real MCP client over the configured
 * transport, queries `tools/list`, and adapts each MCP tool into the runtime
 * `Tool` shape so it lives alongside built-in tools in ToolGateway.
 */
export class McpGateway extends IMcpGateway {
  private clients = new Map<string, Client>()

  async connect(cfg: IMcpServerConfig): Promise<Tool[]> {
    if (cfg.enabled === false) {
      console.log(`[mcp] ${cfg.name}: disabled, skipping`)
      return []
    }
    let transport: Transport
    try {
      transport = this.buildTransport(cfg)
    } catch (err) {
      console.warn(`[mcp] ${cfg.name}: bad transport config — ${(err as Error).message}`)
      return []
    }

    const client = new Client(CLIENT_INFO)
    try {
      await client.connect(transport)
    } catch (err) {
      console.warn(`[mcp] ${cfg.name}: connect failed — ${(err as Error).message}`)
      return []
    }
    this.clients.set(cfg.name, client)

    let listed: { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    try {
      listed = (await client.listTools()) as typeof listed
    } catch (err) {
      console.warn(`[mcp] ${cfg.name}: tools/list failed — ${(err as Error).message}`)
      return []
    }

    const wrapped = listed.tools.map((t) => this.wrapTool(cfg.name, client, t))
    console.log(`[mcp] ${cfg.name}: registered ${wrapped.length} tools`)
    return wrapped
  }

  async closeAll(): Promise<void> {
    const closes = [...this.clients.values()].map((c) =>
      c.close().catch((err) => console.warn("[mcp] close error:", err)),
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
