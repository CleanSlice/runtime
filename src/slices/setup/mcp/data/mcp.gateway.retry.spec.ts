import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { ToolContext } from "../../../agent/tool"
import type { IActor } from "../domain/actor"
import type { IMcpServerConfig } from "../domain/mcp.types"
import { McpGateway, type IMcpClient } from "./mcp.gateway"

/**
 * A tool server that is not there (CLEAN-245). On 20 November an agent's pod
 * started while the API was restarting: three servers answered 503 once, were
 * forgotten, and the agent ran without them until someone restarted it. A
 * server that does not answer now stays known and can be tried again; a call
 * that meets a broken connection is repeated only when repeating is safe.
 */

const OWNER: IActor = { kind: "person", token: "acting-token-of-the-owner" }
const ctx: ToolContext = { sessionId: "s", agentDir: "/agent", send: async () => {}, actor: OWNER }

const unavailable = () =>
  new StreamableHTTPError(503, "Error POSTing to endpoint: <html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>")
const unauthorized = () => new StreamableHTTPError(401, "Error POSTing to endpoint: Unauthorized")

interface IScript {
  list?: () => unknown
  call?: () => unknown
}

class FakeClient {
  calls = 0
  closed = false
  constructor(private readonly script: IScript) {}
  async listTools() {
    return (this.script.list?.() ?? {
      tools: [{ name: "search", annotations: { readOnlyHint: true } }, { name: "create_page" }],
    }) as { tools: Array<{ name: string }> }
  }
  async callTool(params: { name: string }) {
    this.calls++
    return (this.script.call?.() ?? { content: [{ type: "text", text: `ran ${params.name}` }] }) as { content: unknown }
  }
  async close() {
    this.closed = true
  }
}

type Opening = IScript | Error | "hang"

/** Each `open` takes the next entry: a script answers, an Error is thrown, "hang" never answers. */
class TestGateway extends McpGateway {
  readonly opened: FakeClient[] = []
  opens = 0
  /** Resolves a hung open, as a server that answers after everyone left. */
  late: Array<(script: IScript) => void> = []
  constructor(private readonly openings: Opening[]) {
    super()
  }
  protected override async open(_cfg: IMcpServerConfig): Promise<IMcpClient> {
    const next = this.openings[this.opens++]
    if (next === undefined) throw new Error("connect ECONNREFUSED 10.0.0.1:3000")
    if (next instanceof Error) throw next
    if (next === "hang") {
      return new Promise<IMcpClient>((resolve) => {
        this.late.push((script) => resolve(this.make(script)))
      })
    }
    return this.make(next)
  }
  private make(script: IScript): IMcpClient {
    const client = new FakeClient(script)
    this.opened.push(client)
    return client as unknown as IMcpClient
  }
}

const throws = (make: () => Error) => () => {
  throw make()
}

const docsCfg: IMcpServerConfig = {
  id: "srv-docs",
  name: "Documents",
  transport: "streamableHttp",
  url: "http://docs.test/mcp",
  authType: "bearer",
  authValue: "documents-token",
}

let savedTimeout: string | undefined
beforeEach(() => {
  savedTimeout = process.env.MCP_CONNECT_TIMEOUT_MS
})
afterEach(() => {
  if (savedTimeout === undefined) delete process.env.MCP_CONNECT_TIMEOUT_MS
  else process.env.MCP_CONNECT_TIMEOUT_MS = savedTimeout
})

describe("a server that does not answer at start", () => {
  test("stays known, and says why", async () => {
    const gateway = new TestGateway([unavailable()])

    expect(await gateway.connect(docsCfg)).toEqual([])

    const [state] = gateway.status()
    expect(state).toMatchObject({ id: "srv-docs", name: "Documents", state: "retrying", attempts: 1, lastError: "HTTP 503" })
    expect(Number.isNaN(Date.parse(state!.since))).toBe(false)
  })

  test("the next attempt connects it and hands back its tools", async () => {
    const gateway = new TestGateway([unavailable(), {}])
    await gateway.connect(docsCfg)

    const tools = await gateway.attempt("Documents")

    expect(tools!.map((t) => t.name)).toEqual(["Documents__search", "Documents__create_page"])
    expect(gateway.status()[0]).toEqual({
      id: "srv-docs",
      name: "Documents",
      state: "connected",
      since: gateway.status()[0]!.since,
      attempts: 0,
    })
    expect(await tools![0]!.execute({}, ctx)).toEqual([{ type: "text", text: "ran search" }])
  })

  test("each failed attempt is counted", async () => {
    const gateway = new TestGateway([unavailable(), unavailable(), new Error("socket hang up")])
    await gateway.connect(docsCfg)

    expect(await gateway.attempt("Documents")).toBeNull()
    expect(await gateway.attempt("Documents")).toBeNull()

    expect(gateway.status()[0]).toMatchObject({ state: "retrying", attempts: 3, lastError: "socket hang up" })
  })

  test("attempts made at the same moment are one attempt", async () => {
    const gateway = new TestGateway([unavailable(), {}])
    await gateway.connect(docsCfg)

    const [a, b] = await Promise.all([gateway.attempt("Documents"), gateway.attempt("Documents")])

    expect(a).toBe(b)
    expect(gateway.opens).toBe(2)
  })

  test("opening is not enough: a server whose tools cannot be listed is still missing", async () => {
    const gateway = new TestGateway([{ list: throws(unavailable) }, { list: throws(unavailable) }, {}])
    expect(await gateway.connect(docsCfg)).toEqual([])
    expect(gateway.opened.map((c) => c.closed)).toEqual([true, true])
    expect(gateway.status()[0]).toMatchObject({ state: "retrying", lastError: "HTTP 503" })

    expect((await gateway.attempt("Documents"))!.length).toBe(2)
  })

  test("a server that is not this agent's is not tried", async () => {
    const gateway = new TestGateway([])
    expect(await gateway.attempt("Nobody")).toBeNull()
    expect(gateway.opens).toBe(0)
  })

  test("an address that never answers is given up on after the connect timeout", async () => {
    process.env.MCP_CONNECT_TIMEOUT_MS = "20"
    const gateway = new TestGateway(["hang"])

    expect(await gateway.connect(docsCfg)).toEqual([])
    expect(gateway.status()[0]).toMatchObject({ state: "retrying", attempts: 1 })
    expect(gateway.status()[0]!.lastError).toContain("ETIMEDOUT")

    // It answers after everyone stopped waiting: nobody holds that client, so it is closed.
    gateway.late[0]!({})
    await new Promise((r) => setTimeout(r, 5))
    expect(gateway.opened[0]!.closed).toBe(true)
    expect(gateway.status()[0]).toMatchObject({ state: "retrying" })
  })
})

describe("a server that refuses the credentials", () => {
  test("is not tried again", async () => {
    const gateway = new TestGateway([unauthorized(), {}])

    expect(await gateway.connect(docsCfg)).toEqual([])
    expect(gateway.status()[0]).toMatchObject({ state: "refused", attempts: 1 })

    expect(await gateway.attempt("Documents")).toBeNull()
    expect(gateway.opens).toBe(1)
  })

  test("a call that is refused says so, and later calls are not sent", async () => {
    const gateway = new TestGateway([{ call: throws(unauthorized) }, {}])
    const [search] = await gateway.connect(docsCfg)

    expect(await search!.execute({}, ctx)).toEqual({ error: "Documents refused this agent's credentials." })
    expect(gateway.status()[0]).toMatchObject({ state: "refused" })
    expect(gateway.opened[0]!.closed).toBe(true)

    expect(await search!.execute({}, ctx)).toEqual({ error: "Documents refused this agent's credentials." })
    expect(gateway.opens).toBe(1)
  })
})

describe("the connection breaks under a call", () => {
  test("a read is repeated once on a new connection", async () => {
    const gateway = new TestGateway([{ call: throws(unavailable) }, {}])
    const [search] = await gateway.connect(docsCfg)

    expect(await search!.execute({}, ctx)).toEqual([{ type: "text", text: "ran search" }])

    expect(gateway.opened[0]!.closed).toBe(true)
    expect(gateway.opened[1]!.calls).toBe(1)
    expect(gateway.status()[0]).toMatchObject({ state: "connected", attempts: 0 })
  })

  test("a read that still fails says the server is not reachable, and the server is tried again", async () => {
    const gateway = new TestGateway([{ call: throws(unavailable) }])
    const [search] = await gateway.connect(docsCfg)

    expect(await search!.execute({}, ctx)).toEqual({ error: "Documents is not reachable right now." })
    expect(gateway.status()[0]).toMatchObject({ state: "retrying", attempts: 1 })
  })

  test("a call that changes something is not sent twice", async () => {
    const gateway = new TestGateway([{ call: throws(() => new Error("read ECONNRESET")) }, {}])
    const [, createPage] = await gateway.connect(docsCfg)

    expect(await createPage!.execute({}, ctx)).toEqual({
      error: "Documents could not be reached while this ran; whether it took effect is unknown. Check before trying again.",
    })

    expect(gateway.opens).toBe(1)
    expect(gateway.opened[0]!.calls).toBe(1)
    expect(gateway.status()[0]).toMatchObject({ state: "retrying", lastError: "read ECONNRESET" })
  })

  test("the next call opens the server itself: nothing was sent yet", async () => {
    const gateway = new TestGateway([{ call: throws(() => new Error("read ECONNRESET")) }, {}])
    const [, createPage] = await gateway.connect(docsCfg)
    await createPage!.execute({}, ctx)

    expect(await createPage!.execute({}, ctx)).toEqual([{ type: "text", text: "ran create_page" }])
    expect(gateway.status()[0]).toMatchObject({ state: "connected", attempts: 0 })
  })

  test("an error of the tool itself passes through and changes nothing", async () => {
    const gateway = new TestGateway([{ call: throws(() => new Error("MCP error -32602: invalid params")) }])
    const [search] = await gateway.connect(docsCfg)

    const result = (await search!.execute({}, ctx)) as { error: string }
    expect(result.error).toContain("invalid params")
    expect(gateway.opens).toBe(1)
    expect(gateway.status()[0]).toMatchObject({ state: "connected" })
  })
})

describe("who is told", () => {
  test("every change of a server reaches the listener, until it unsubscribes", async () => {
    const gateway = new TestGateway([unavailable(), {}])
    const seen: string[] = []
    const off = gateway.onChange(() => seen.push(gateway.status()[0]?.state ?? "none"))

    await gateway.connect(docsCfg)
    await gateway.attempt("Documents")
    expect(seen).toEqual(["retrying", "connected"])

    off()
    await gateway.forget("Documents")
    expect(seen).toHaveLength(2)
    expect(gateway.status()).toEqual([])
  })

  test("what leaves the gateway carries no credential", async () => {
    const gateway = new TestGateway([new Error("GET http://docs.test/mcp?token=documents-token failed: Authorization: Bearer documents-token")])
    await gateway.connect(docsCfg)
    expect(gateway.status()[0]!.lastError).not.toContain("documents-token")
  })
})
