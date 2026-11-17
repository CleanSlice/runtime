import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Tool, ToolContext } from "../../../agent/tool"
import type { IActor } from "../domain/actor"
import type { IMcpServerConfig } from "../domain/mcp.types"
import { McpGateway, isLostSession, type IMcpClient } from "./mcp.gateway"

/**
 * A lost MCP session (CLEAN-232, R17). Ranch keeps sessions in memory, so
 * after an API restart the next request answers 404 `Session not found`.
 * The gateway drops the client, opens a new one and retries once; if that
 * fails too the tool says the server is not reachable, and nothing more.
 */

const RANCH_TOKEN = "agent-ranch-token"
const OWNER: IActor = { kind: "person", token: "acting-token-of-the-owner" }

/** What `StreamableHTTPClientTransport.send` throws for the API's 404. */
const lostSession = () =>
  new StreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Session not found"},"id":null}')

interface IScript {
  list?: () => unknown
  call?: () => unknown
}

class FakeClient {
  lists = 0
  calls = 0
  closed = false
  constructor(private readonly script: IScript) {}
  async listTools() {
    this.lists++
    return (this.script.list?.() ?? { tools: [{ name: "list_agents" }] }) as { tools: Array<{ name: string }> }
  }
  async callTool(params: { name: string }) {
    this.calls++
    return (this.script.call?.() ?? { content: [{ type: "text", text: `ran ${params.name}` }] }) as { content: unknown }
  }
  async close() {
    this.closed = true
  }
}

/** Each `open` takes the next script; with none left the server is down. */
class TestGateway extends McpGateway {
  readonly opened: FakeClient[] = []
  constructor(private readonly scripts: IScript[]) {
    super()
  }
  protected override async open(_cfg: IMcpServerConfig): Promise<IMcpClient> {
    const script = this.scripts[this.opened.length]
    if (!script) throw new Error("connect ECONNREFUSED")
    const client = new FakeClient(script)
    this.opened.push(client)
    return client as unknown as IMcpClient
  }
}

const throws = (make: () => Error) => () => {
  throw make()
}

const ranchCfg: IMcpServerConfig = {
  name: "Ranch",
  transport: "streamableHttp",
  url: "http://ranch.test/mcp",
  authType: "bearer",
  authValue: RANCH_TOKEN,
}

const ctx: ToolContext = { sessionId: "s", agentDir: "/agent", send: async () => {}, actor: OWNER }

let savedToken: string | undefined
beforeEach(() => {
  savedToken = process.env.RANCH_API_TOKEN
  process.env.RANCH_API_TOKEN = RANCH_TOKEN
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.RANCH_API_TOKEN
  else process.env.RANCH_API_TOKEN = savedToken
})

describe("isLostSession", () => {
  test("the SDK's error for a 404 from the streamable HTTP endpoint", () => {
    expect(isLostSession(lostSession())).toBe(true)
    expect(isLostSession(new StreamableHTTPError(404, "Error POSTing to endpoint: Not Found"))).toBe(true)
  })

  test("the server's own words, whatever carried them", () => {
    expect(isLostSession(new Error("MCP error -32000: Session not found"))).toBe(true)
    expect(isLostSession(new Error("Error POSTing to endpoint (HTTP 404): Session not found"))).toBe(true)
  })

  test("not another failure", () => {
    expect(isLostSession(new StreamableHTTPError(500, "Error POSTing to endpoint: boom"))).toBe(false)
    expect(isLostSession(new StreamableHTTPError(401, "Error POSTing to endpoint: Unauthorized"))).toBe(false)
    expect(isLostSession(new Error("MCP error -32602: agent 404 not found"))).toBe(false)
    expect(isLostSession("Session not found")).toBe(false)
  })
})

describe("a tool call after the server forgot the session", () => {
  test("reconnects and retries once, and the call succeeds", async () => {
    let lost = false
    const gateway = new TestGateway([{ call: () => { if (lost) throw lostSession(); return undefined } }, {}])
    const [tool] = await gateway.connect(ranchCfg)
    expect(await tool!.execute({}, ctx)).toEqual([{ type: "text", text: "ran list_agents" }])

    lost = true
    const result = await tool!.execute({}, ctx)

    expect(result).toEqual([{ type: "text", text: "ran list_agents" }])
    expect(gateway.opened).toHaveLength(2)
    expect(gateway.opened[0]!.closed).toBe(true)
    expect(gateway.opened[0]!.calls).toBe(2)
    expect(gateway.opened[1]!.calls).toBe(1)

    // The new client is the server's client from now on.
    await tool!.execute({}, ctx)
    expect(gateway.opened).toHaveLength(2)
    expect(gateway.opened[1]!.calls).toBe(2)
  })

  test("a second failure is the plain unavailable result, with no next step", async () => {
    const gateway = new TestGateway([{ call: throws(lostSession) }, { call: throws(lostSession) }, {}])
    const [tool] = await gateway.connect(ranchCfg)

    const result = await tool!.execute({}, ctx)

    expect(result).toEqual({ error: "Ranch is not reachable right now." })
    expect(Object.keys(result as object)).toEqual(["error"])
    // One reconnect, one retry: not a loop.
    expect(gateway.opened).toHaveLength(2)
    expect(gateway.opened[1]!.calls).toBe(1)
  })

  test("the retry failing for another reason is unavailable too", async () => {
    const gateway = new TestGateway([{ call: throws(lostSession) }, { call: throws(() => new Error("socket hang up")) }])
    const [tool] = await gateway.connect(ranchCfg)

    expect(await tool!.execute({}, ctx)).toEqual({ error: "Ranch is not reachable right now." })
  })

  test("a reconnect that cannot be made is unavailable, and the next call tries again", async () => {
    const scripts: IScript[] = [{ call: throws(lostSession) }]
    const gateway = new TestGateway(scripts)
    const [tool] = await gateway.connect(ranchCfg)

    expect(await tool!.execute({}, ctx)).toEqual({ error: "Ranch is not reachable right now." })

    scripts.push({})
    expect(await tool!.execute({}, ctx)).toEqual([{ type: "text", text: "ran list_agents" }])
  })

  test("the server's name is the one in the message", async () => {
    const gateway = new TestGateway([{ call: throws(lostSession) }])
    const [tool] = await gateway.connect({ ...ranchCfg, name: "Documents" })

    expect(await tool!.execute({}, ctx)).toEqual({ error: "Documents is not reachable right now." })
  })

  test("any other error is reported as before, without a reconnect", async () => {
    const gateway = new TestGateway([{ call: throws(() => new StreamableHTTPError(500, "Error POSTing to endpoint: boom")) }, {}])
    const [tool] = await gateway.connect(ranchCfg)

    const result = (await tool!.execute({}, ctx)) as { error: string }

    expect(result.error).toBe("MCP Ranch.list_agents failed: Streamable HTTP error: Error POSTing to endpoint: boom")
    expect(gateway.opened).toHaveLength(1)
  })

  test("calls that fail together share one reconnect", async () => {
    let lost = false
    const gateway = new TestGateway([{ call: () => { if (lost) throw lostSession(); return undefined } }, {}])
    const [tool] = await gateway.connect(ranchCfg)
    await tool!.execute({}, ctx) // the caller's catalogue is cached from here on
    lost = true

    const results = await Promise.all([tool!.execute({}, ctx), tool!.execute({}, ctx), tool!.execute({}, ctx)])

    for (const result of results) expect(result).toEqual([{ type: "text", text: "ran list_agents" }])
    expect(gateway.opened).toHaveLength(2)
  })

  test("a server that is not Ranch's recovers the same way", async () => {
    const gateway = new TestGateway([{ call: throws(lostSession) }, {}])
    const [tool] = await gateway.connect({ ...ranchCfg, name: "jira", authValue: "a-jira-token" })

    expect(await tool!.execute({}, ctx)).toEqual([{ type: "text", text: "ran list_agents" }])
    expect(gateway.opened).toHaveLength(2)
  })
})

describe("tools/list after the server forgot the session", () => {
  test("reconnects and lists for the turn's actor", async () => {
    let lost = false
    const gateway = new TestGateway([{ list: () => { if (lost) throw lostSession(); return undefined } }, {}])
    const registry = await gateway.connect(ranchCfg)
    lost = true

    const scoped = await gateway.scopeTools(registry, OWNER)

    expect(scoped.map((t: Tool) => t.name)).toEqual(["Ranch__list_agents"])
    expect(gateway.opened).toHaveLength(2)
    expect(gateway.opened[1]!.lists).toBe(1)
  })

  test("still failing: the turn gets none of the server's tools", async () => {
    let lost = false
    const gateway = new TestGateway([{ list: () => { if (lost) throw lostSession(); return undefined } }, { list: throws(lostSession) }])
    const registry = await gateway.connect(ranchCfg)
    lost = true

    expect(await gateway.scopeTools(registry, OWNER)).toEqual([])
  })
})

/**
 * The same thing over the real SDK transport, against a server that behaves
 * like Ranch's endpoint: sessions in memory, 404 `Session not found` for one
 * it does not know. This is what pins the error shape the SDK really throws.
 */
describe("over the SDK's streamable HTTP transport", () => {
  test("an API restart between two calls is not noticed by the caller", async () => {
    const sessions = new Set<string>()
    const seen: Array<{ method: string; session: string | null; meta?: unknown; auth: string | null }> = []
    let initialized = 0
    let refusing = false

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "GET") return new Response(null, { status: 405 })
        if (req.method === "DELETE") return new Response(null, { status: 200 })
        const body = (await req.json()) as { id?: number; method: string; params?: { _meta?: unknown; protocolVersion?: string; name?: string } }
        const session = req.headers.get("mcp-session-id")
        seen.push({ method: body.method, session, meta: body.params?._meta, auth: req.headers.get("authorization") })
        const json = (result: unknown, headers: Record<string, string> = {}) =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            headers: { "content-type": "application/json", ...headers },
          })

        if (body.method === "initialize") {
          if (refusing) return new Response("Service Unavailable", { status: 503 })
          const id = `session-${++initialized}`
          sessions.add(id)
          return json(
            { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ranch", version: "0" } },
            { "mcp-session-id": id },
          )
        }
        if (!session || !sessions.has(session)) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null }),
            { status: 404, headers: { "content-type": "application/json" } },
          )
        }
        if (body.id === undefined) return new Response(null, { status: 202 })
        if (body.method === "tools/list") return json({ tools: [{ name: "list_agents", inputSchema: { type: "object" } }] })
        if (body.method === "tools/call") return json({ content: [{ type: "text", text: `ran ${body.params?.name} in ${session}` }] })
        return json({})
      },
    })

    const gateway = new McpGateway()
    try {
      const [tool] = await gateway.connect({ ...ranchCfg, url: `http://127.0.0.1:${server.port}/mcp` })
      expect(tool!.name).toBe("Ranch__list_agents")
      expect(await tool!.execute({}, ctx)).toEqual([{ type: "text", text: "ran list_agents in session-1" }])

      // The API restarts: every session it held is gone.
      sessions.clear()

      expect(await tool!.execute({}, ctx)).toEqual([{ type: "text", text: "ran list_agents in session-2" }])
      expect(initialized).toBe(2)

      // The actor travelled in `_meta` of both kinds of request, on the wire.
      const lists = seen.filter((r) => r.method === "tools/list")
      const calls = seen.filter((r) => r.method === "tools/call")
      expect(lists[0]!.meta).toEqual({ "ranch/actor": { kind: "trusted", via: "internal" } })
      expect(lists[1]!.meta).toEqual({ "ranch/actor": OWNER })
      expect(calls.map((r) => r.meta)).toEqual([{ "ranch/actor": OWNER }, { "ranch/actor": OWNER }, { "ranch/actor": OWNER }])
      // First call, the call the restart broke, and its retry in the new session.
      expect(calls.map((r) => r.session)).toEqual(["session-1", "session-1", "session-2"])
      expect(seen.every((r) => r.auth === `Bearer ${RANCH_TOKEN}`)).toBe(true)

      // The session is lost again and this time no new one can be opened:
      // one plain sentence, no route offered.
      sessions.clear()
      refusing = true
      expect(await tool!.execute({}, ctx)).toEqual({ error: "Ranch is not reachable right now." })
    } finally {
      server.stop(true)
      await gateway.closeAll()
    }
  })
})
