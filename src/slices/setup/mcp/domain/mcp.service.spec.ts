import { describe, expect, it } from "bun:test"
import { z } from "zod"
import type { Tool } from "../../../agent/tool"
import { McpService, countFor, swapServerTools } from "./mcp.service"
import { IMcpGateway, type IMcpReconnectResult } from "./mcp.gateway"
import { McpFetcher } from "./mcp.fetcher"
import type { IMcpServerConfig } from "./mcp.types"
import {
  mcpOauthSecretKey,
  resolveBundleKey,
  subjectOfSecretKey,
  type ISecretStore,
} from "../data/mcpOauth.provider"
import { subjectOf } from "../data/mcp.gateway"

/**
 * The live-registry half of CLEAN-79/81: a login swaps a server's tools in
 * the array the runtime holds, never in a copy; and the identity/key rules
 * that decide whose token a call uses.
 */

const tool = (name: string): Tool => ({
  name,
  description: name,
  schema: z.any(),
  execute: async () => null,
})

class FakeGateway extends IMcpGateway {
  reconnectResult: IMcpReconnectResult | null = null
  calls: Array<{ serverId: string; subject: string }> = []
  async connect(_cfg: IMcpServerConfig): Promise<Tool[]> {
    return []
  }
  async reconnect(serverId: string, subject: string): Promise<IMcpReconnectResult | null> {
    this.calls.push({ serverId, subject })
    return this.reconnectResult
  }
  async closeAll(): Promise<void> {}
}

describe("swapServerTools", () => {
  it("replaces only that server's tools, in place", () => {
    const registry = [tool("skill_write"), tool("silpo__connect"), tool("jira__search")]
    const before = registry

    swapServerTools(registry, "silpo", [tool("silpo__connect"), tool("silpo__get_cart")])

    expect(registry).toBe(before)
    expect(registry.map((t) => t.name)).toEqual([
      "skill_write",
      "jira__search",
      "silpo__connect",
      "silpo__get_cart",
    ])
  })

  it("does not touch a server whose name merely shares a prefix", () => {
    const registry = [tool("silpo__connect"), tool("silpo_v2__search")]
    swapServerTools(registry, "silpo", [tool("silpo__x")])
    expect(registry.map((t) => t.name)).toEqual(["silpo_v2__search", "silpo__x"])
  })

  it("counts live tools without the connect tool", () => {
    const registry = [tool("silpo__connect"), tool("silpo__a"), tool("silpo__b"), tool("other__c")]
    expect(countFor(registry, "silpo")).toBe(2)
    expect(countFor(registry, "other")).toBe(1)
  })
})

describe("McpService.handleConnected", () => {
  const event = { server: "Silpo", serverId: "srv-1", subject: "user-a" }

  it("swaps the connect-only surface for the real tools the first time", async () => {
    const gateway = new FakeGateway()
    gateway.reconnectResult = {
      serverName: "Silpo",
      tools: [tool("Silpo__connect"), tool("Silpo__get_cart"), tool("Silpo__search")],
    }
    const service = new McpService(gateway, new McpFetcher())
    const registry = [tool("skill_write"), tool("Silpo__connect")]

    const live = await service.handleConnected(event, registry)

    expect(gateway.calls).toEqual([{ serverId: "srv-1", subject: "user-a" }])
    expect(live).toBe(2)
    expect(registry.map((t) => t.name)).toEqual([
      "skill_write",
      "Silpo__connect",
      "Silpo__get_cart",
      "Silpo__search",
    ])
  })

  it("leaves the registry alone when only a client was opened", async () => {
    const gateway = new FakeGateway()
    gateway.reconnectResult = { serverName: "Silpo", tools: null }
    const service = new McpService(gateway, new McpFetcher())
    const registry = [tool("Silpo__connect"), tool("Silpo__get_cart")]

    const live = await service.handleConnected(event, registry)

    expect(live).toBe(1)
    expect(registry.map((t) => t.name)).toEqual(["Silpo__connect", "Silpo__get_cart"])
  })

  it("ignores a server this runtime does not run", async () => {
    const gateway = new FakeGateway()
    const service = new McpService(gateway, new McpFetcher())
    const registry = [tool("skill_write")]

    expect(await service.handleConnected(event, registry)).toBeNull()
    expect(registry).toHaveLength(1)
  })
})

describe("whose token a call uses", () => {
  it("prefers the console login over the channel id, and falls back to it", () => {
    expect(subjectOf({ from: "admin", user: { id: "user-a" } })).toBe("user-a")
    expect(subjectOf({ from: "share-v7" })).toBe("share-v7")
    expect(subjectOf({ from: "123456789" })).toBe("123456789")
    expect(subjectOf({})).toBeUndefined()
  })

  it("builds and reads both key shapes", () => {
    expect(mcpOauthSecretKey("srv-1")).toBe("mcpOauth:srv-1")
    expect(mcpOauthSecretKey("srv-1", "user-a")).toBe("mcpOauth:srv-1:user-a")
    expect(subjectOfSecretKey("srv-1", "mcpOauth:srv-1")).toBeNull()
    expect(subjectOfSecretKey("srv-1", "mcpOauth:srv-1:share-v7")).toBe("share-v7")
    expect(subjectOfSecretKey("srv-1", "mcpOauth:srv-2:user-a")).toBeUndefined()
    expect(subjectOfSecretKey("srv-1", "GITHUB_TOKEN")).toBeUndefined()
  })

  it("resolves the person's own bundle first, then the agent-wide one, then nothing", async () => {
    const store = new Map<string, string>([
      ["mcpOauth:srv-1", "{}"],
      ["mcpOauth:srv-1:user-a", "{}"],
    ])
    const secrets: ISecretStore = {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        store.set(k, v)
      },
    }

    expect(await resolveBundleKey(secrets, "srv-1", "user-a")).toBe("mcpOauth:srv-1:user-a")
    expect(await resolveBundleKey(secrets, "srv-1", "user-b")).toBe("mcpOauth:srv-1")
    store.delete("mcpOauth:srv-1")
    expect(await resolveBundleKey(secrets, "srv-1", "user-b")).toBeNull()
  })
})

describe("isAuthFailure", () => {
  const { isAuthFailure } = require("../data/mcp.gateway") as typeof import("../data/mcp.gateway")
  const named = (name: string) => Object.assign(new Error("x"), { name })
  const coded = (code: number) => Object.assign(new Error("HTTP"), { code })

  it("recognises the SDK's and the provider's own refusals", () => {
    expect(isAuthFailure(named("UnauthorizedError"))).toBe(true)
    expect(isAuthFailure(coded(401))).toBe(true)
    expect(isAuthFailure(new Error("MCP OAuth token expired or revoked — the user must reconnect from the chat"))).toBe(true)
  })

  it("recognises a dead grant reported as a plain tool error (seen live with Silpo)", () => {
    expect(isAuthFailure(new Error("MCP Silpo.silpo_get_my_profile failed: Grant not found"))).toBe(true)
    expect(isAuthFailure(new Error("invalid_grant"))).toBe(true)
    expect(isAuthFailure(new Error("Token expired"))).toBe(true)
  })

  it("leaves ordinary tool errors alone", () => {
    expect(isAuthFailure(new Error("MCP error -32602: branchId and deliveryType are required"))).toBe(false)
    expect(isAuthFailure(new Error("ECONNRESET"))).toBe(false)
    expect(isAuthFailure("not an error")).toBe(false)
  })
})
