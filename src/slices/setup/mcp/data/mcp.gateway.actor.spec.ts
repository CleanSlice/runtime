import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { z } from "zod"
import type { Tool, ToolContext } from "../../../agent/tool"
import type { IActor } from "../domain/actor"
import type { IMcpServerConfig } from "../domain/mcp.types"
import { CATALOGUE_TTL_MS, McpGateway, isRanchServer, type IMcpClient } from "./mcp.gateway"

/**
 * The acting party on the wire (CLEAN-232): Ranch's own server is told who
 * every `tools/list` and `tools/call` is for and lists per caller; no other
 * server ever sees the actor, let alone the token.
 */

const RANCH_TOKEN = "agent-ranch-token"
const USER_TOKEN = "acting-token-of-a-user"
const OWNER_TOKEN = "acting-token-of-the-owner"

const USER: IActor = { kind: "person", token: USER_TOKEN }
const OWNER: IActor = { kind: "person", token: OWNER_TOKEN }
const GUEST: IActor = { kind: "guest" }
const SELF: IActor = { kind: "trusted", via: "internal" }

type Params = { name?: string; arguments?: unknown; _meta?: Record<string, unknown> } | undefined
type Descriptor = { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }

class FakeClient {
  lists: Params[] = []
  calls: Params[] = []
  closed = false
  constructor(private readonly catalogue: (params: Params) => Descriptor[]) {}
  async listTools(params?: Params) {
    this.lists.push(params)
    return { tools: this.catalogue(params) }
  }
  async callTool(params: Params) {
    this.calls.push(params)
    return { content: [{ type: "text", text: `ran ${params?.name}` }] }
  }
  async close() {
    this.closed = true
  }
}

/** The gateway with the network taken out: `open` hands back a fake client per server. */
class TestGateway extends McpGateway {
  readonly clients = new Map<string, FakeClient>()
  constructor(private readonly catalogues: Record<string, (params: Params) => Descriptor[]>) {
    super()
  }
  protected override async open(cfg: IMcpServerConfig): Promise<IMcpClient> {
    const client = new FakeClient(this.catalogues[cfg.name]!)
    this.clients.set(cfg.name, client)
    return client as unknown as IMcpClient
  }
}

const actorIn = (params: Params): IActor | undefined => params?._meta?.["ranch/actor"] as IActor | undefined

/** A Ranch that lists per caller, the way the API will after CLEAN-232. */
function ranchCatalogue(params: Params): Descriptor[] {
  const actor = actorIn(params)
  const everyone = [{ name: "query_knowledge", annotations: { readOnlyHint: true } }]
  if (!actor || actor.kind === "guest") return everyone
  if (actor.kind === "person" && actor.token === USER_TOKEN) return [...everyone, { name: "pin_agent" }]
  return [...everyone, { name: "list_agents" }, { name: "delete_agent" }]
}

/** A Ranch from before the change: it ignores `_meta` and lists everything. */
const oldRanchCatalogue = (): Descriptor[] => [{ name: "query_knowledge" }, { name: "list_agents" }, { name: "delete_agent" }]

const ranchCfg: IMcpServerConfig = {
  name: "Ranch",
  transport: "streamableHttp",
  url: "http://ranch.test/mcp",
  authType: "bearer",
  authValue: RANCH_TOKEN,
}
const jiraCfg: IMcpServerConfig = {
  name: "jira",
  transport: "streamableHttp",
  url: "http://jira.test/mcp",
  authType: "bearer",
  authValue: "a-jira-token",
}

const builtin = (name: string): Tool => ({ name, description: name, schema: z.any(), execute: async () => null })

const ctxOf = (actor?: IActor): ToolContext => ({
  sessionId: "s",
  agentDir: "/agent",
  send: async () => {},
  ...(actor ? { actor } : {}),
  ...(actor?.kind === "person" ? { acting: { token: actor.token, role: "User" as const, surface: "app" as const } } : {}),
})

const names = (tools: Tool[]) => tools.map((t) => t.name)

let savedToken: string | undefined
beforeEach(() => {
  savedToken = process.env.RANCH_API_TOKEN
  process.env.RANCH_API_TOKEN = RANCH_TOKEN
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.RANCH_API_TOKEN
  else process.env.RANCH_API_TOKEN = savedToken
  setSystemTime()
})

describe("which server is Ranch's own", () => {
  test("the one the agent signs in to with its own Ranch token", () => {
    expect(isRanchServer(ranchCfg)).toBe(true)
  })

  test("not a server with another bearer, another auth type, or no auth", () => {
    expect(isRanchServer(jiraCfg)).toBe(false)
    expect(isRanchServer({ ...ranchCfg, authType: "header", authValue: `Authorization: Bearer ${RANCH_TOKEN}` })).toBe(false)
    expect(isRanchServer({ ...ranchCfg, authType: "oauth", authValue: RANCH_TOKEN })).toBe(false)
    expect(isRanchServer({ ...ranchCfg, authType: "none", authValue: null })).toBe(false)
  })

  test("no server at all when the agent has no Ranch token", () => {
    delete process.env.RANCH_API_TOKEN
    expect(isRanchServer(ranchCfg)).toBe(false)
    expect(isRanchServer({ ...ranchCfg, authValue: "" })).toBe(false)
    process.env.RANCH_API_TOKEN = ""
    expect(isRanchServer({ ...ranchCfg, authValue: "" })).toBe(false)
  })
})

describe("_meta[\"ranch/actor\"] on the Ranch server", () => {
  test("tools/list at boot is asked as the agent itself", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registered = await gateway.connect(ranchCfg)

    expect(gateway.clients.get("Ranch")!.lists).toEqual([{ _meta: { "ranch/actor": SELF } }])
    expect(names(registered)).toEqual(["Ranch__query_knowledge", "Ranch__list_agents", "Ranch__delete_agent"])
  })

  test("tools/list for a turn carries that turn's actor", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    await gateway.scopeTools(registry, USER)
    await gateway.scopeTools(registry, GUEST)

    expect(gateway.clients.get("Ranch")!.lists.map(actorIn)).toEqual([SELF, USER, GUEST])
  })

  test("tools/call carries the actor of the context, exactly as the contract writes it", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    const tools = await gateway.scopeTools(registry, OWNER)
    const listAgents = tools.find((t) => t.name === "Ranch__list_agents")!

    const result = await listAgents.execute({ limit: 5 }, ctxOf(OWNER))

    expect(result).toEqual([{ type: "text", text: "ran list_agents" }])
    expect(gateway.clients.get("Ranch")!.calls).toEqual([
      { name: "list_agents", arguments: { limit: 5 }, _meta: { "ranch/actor": { kind: "person", token: OWNER_TOKEN } } },
    ])
  })

  test("each kind of actor is sent in the contract's shape", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect(ranchCfg)
    const admin: IActor = { kind: "trusted", via: "channel-admin" }
    for (const actor of [SELF, admin, GUEST, USER]) await tool!.execute({}, ctxOf(actor))

    expect(gateway.clients.get("Ranch")!.calls.map((c) => c?._meta)).toEqual([
      { "ranch/actor": { kind: "trusted", via: "internal" } },
      { "ranch/actor": { kind: "trusted", via: "channel-admin" } },
      { "ranch/actor": { kind: "guest" } },
      { "ranch/actor": { kind: "person", token: USER_TOKEN } },
    ])
  })

  test("a context with no actor is a guest's", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect(ranchCfg)
    await tool!.execute({}, ctxOf())

    expect(actorIn(gateway.clients.get("Ranch")!.calls[0])).toEqual({ kind: "guest" })
  })

  test("the actor cannot be set through the tool's arguments", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect(ranchCfg)
    const forged = { _meta: { "ranch/actor": SELF }, actor: SELF, "ranch/actor": SELF }
    await tool!.execute(forged, ctxOf(GUEST))

    const call = gateway.clients.get("Ranch")!.calls[0]!
    expect(call._meta).toEqual({ "ranch/actor": { kind: "guest" } })
    // What the model wrote travels as arguments, where Ranch does not look for an actor.
    expect(call.arguments).toEqual(forged)
  })
})

describe("any other server", () => {
  test("gets no _meta on tools/list or tools/call, and never sees the acting token", async () => {
    const gateway = new TestGateway({ jira: () => [{ name: "search" }] })
    const registry = await gateway.connect(jiraCfg)
    const scoped = await gateway.scopeTools(registry, USER)
    await scoped[0]!.execute({ q: "bug" }, ctxOf(USER))

    const client = gateway.clients.get("jira")!
    expect(client.lists).toEqual([undefined])
    expect(client.calls).toEqual([{ name: "search", arguments: { q: "bug" } }])
    expect("_meta" in client.calls[0]!).toBe(false)
    expect(JSON.stringify([client.lists, client.calls])).not.toContain(USER_TOKEN)
  })

  test("stays out of it when it runs beside the Ranch server", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue, jira: () => [{ name: "search" }] })
    const registry = [...(await gateway.connect(ranchCfg)), ...(await gateway.connect(jiraCfg))]
    const scoped = await gateway.scopeTools(registry, USER)
    for (const tool of scoped) await tool.execute({}, ctxOf(USER))

    const jira = gateway.clients.get("jira")!
    expect(jira.lists).toEqual([undefined])
    expect(jira.calls).toEqual([{ name: "search", arguments: {} }])
    expect(JSON.stringify([jira.lists, jira.calls])).not.toContain("ranch/actor")
    expect(JSON.stringify([jira.lists, jira.calls])).not.toContain(USER_TOKEN)
  })

  test("a server that merely holds the same URL but another credential is not told either", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect({ ...ranchCfg, authValue: "somebody-elses-token" })
    await tool!.execute({}, ctxOf(USER))

    const client = gateway.clients.get("Ranch")!
    expect(client.lists).toEqual([undefined])
    expect("_meta" in client.calls[0]!).toBe(false)
  })
})

describe("the catalogue of a turn", () => {
  test("is what Ranch lists for the actor: a User is not offered what an Owner is", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = [builtin("web_fetch"), ...(await gateway.connect(ranchCfg)), builtin("memory_save")]

    expect(names(await gateway.scopeTools(registry, OWNER))).toEqual([
      "web_fetch",
      "Ranch__query_knowledge",
      "Ranch__list_agents",
      "Ranch__delete_agent",
      "memory_save",
    ])
    expect(names(await gateway.scopeTools(registry, GUEST))).toEqual(["web_fetch", "Ranch__query_knowledge", "memory_save"])
  })

  test("includes a tool Ranch lists for this person alone, though the boot listing never had it", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = [builtin("web_fetch"), ...(await gateway.connect(ranchCfg))]
    const scoped = await gateway.scopeTools(registry, USER)

    expect(names(scoped)).toEqual(["web_fetch", "Ranch__query_knowledge", "Ranch__pin_agent"])
    expect(names(registry)).not.toContain("Ranch__pin_agent")
    const pin = scoped.find((t) => t.name === "Ranch__pin_agent")!
    expect(await pin.execute({ agentId: "a1" }, ctxOf(USER))).toEqual([{ type: "text", text: "ran pin_agent" }])
  })

  test("leaves built-in tools and other servers' tools exactly as they were", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue, jira: () => [{ name: "search" }] })
    const jira = await gateway.connect(jiraCfg)
    const registry = [builtin("web_fetch"), ...jira, ...(await gateway.connect(ranchCfg))]
    const scoped = await gateway.scopeTools(registry, GUEST)

    expect(scoped[0]).toBe(registry[0]!)
    expect(scoped[1]).toBe(jira[0]!)
  })

  test("against an API that ignores the actor, every turn gets today's list in today's order", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const registry = [builtin("web_fetch"), ...(await gateway.connect(ranchCfg)), builtin("memory_save")]

    for (const actor of [USER, OWNER, GUEST, SELF]) {
      const scoped = await gateway.scopeTools(registry, actor)
      expect(scoped).toEqual(registry)
      for (let i = 0; i < scoped.length; i++) expect(scoped[i]).toBe(registry[i]!)
    }
  })

  test("is asked once per actor and kept for 60 seconds", async () => {
    setSystemTime(new Date("2026-11-17T10:00:00Z"))
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    const client = gateway.clients.get("Ranch")!
    expect(client.lists).toHaveLength(1) // boot, as the agent itself

    await gateway.scopeTools(registry, USER)
    await gateway.scopeTools(registry, USER)
    await Promise.all([gateway.scopeTools(registry, USER), gateway.scopeTools(registry, USER)])
    expect(client.lists.map(actorIn)).toEqual([SELF, USER])

    // Another person is another catalogue, and so is another kind of actor.
    await gateway.scopeTools(registry, OWNER)
    await gateway.scopeTools(registry, GUEST)
    expect(client.lists.map(actorIn)).toEqual([SELF, USER, OWNER, GUEST])

    // The boot listing is the agent's own catalogue, already cached.
    await gateway.scopeTools(registry, SELF)
    expect(client.lists).toHaveLength(4)

    setSystemTime(new Date(Date.now() + CATALOGUE_TTL_MS - 1000))
    await gateway.scopeTools(registry, USER)
    expect(client.lists).toHaveLength(4)

    setSystemTime(new Date(Date.now() + 2000))
    await gateway.scopeTools(registry, USER)
    expect(client.lists.map(actorIn)).toEqual([SELF, USER, OWNER, GUEST, USER])
  })

  test("concurrent turns of one actor share a single tools/list", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    await Promise.all([1, 2, 3, 4, 5].map(() => gateway.scopeTools(registry, USER)))

    expect(gateway.clients.get("Ranch")!.lists.map(actorIn)).toEqual([SELF, USER])
  })

  test("a tool absent from the caller's catalogue is not offered and cannot be executed", async () => {
    const gateway = new TestGateway({ Ranch: ranchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    const deleteAgent = registry.find((t) => t.name === "Ranch__delete_agent")!

    expect(names(await gateway.scopeTools(registry, USER))).not.toContain("Ranch__delete_agent")

    // The model names it anyway: the loop finds it in the shared registry.
    const result = await deleteAgent.execute({ id: "a1" }, ctxOf(USER))
    expect(result).toEqual({ error: "\"Ranch__delete_agent\" is not available to this person." })
    expect(gateway.clients.get("Ranch")!.calls).toEqual([])

    // The same tool, the same wrapper, for someone Ranch lists it for.
    expect(await deleteAgent.execute({ id: "a1" }, ctxOf(OWNER))).toEqual([{ type: "text", text: "ran delete_agent" }])
    expect(await deleteAgent.execute({ id: "a1" }, ctxOf(GUEST))).toEqual({
      error: "\"Ranch__delete_agent\" is not available to this person.",
    })
    expect(await deleteAgent.execute({ id: "a1" }, ctxOf())).toEqual({
      error: "\"Ranch__delete_agent\" is not available to this person.",
    })
    expect(gateway.clients.get("Ranch")!.calls).toHaveLength(1)
  })

  test("a Ranch that connected late is listed per caller like one that was there at start (CLEAN-245)", async () => {
    let down = true
    class LateGateway extends TestGateway {
      protected override async open(cfg: IMcpServerConfig): Promise<IMcpClient> {
        if (down) throw new Error("connect ECONNREFUSED")
        return super.open(cfg)
      }
    }
    const gateway = new LateGateway({ Ranch: ranchCatalogue })
    const registry = [builtin("web_fetch"), ...(await gateway.connect(ranchCfg))]
    expect(names(await gateway.scopeTools(registry, OWNER))).toEqual(["web_fetch"])

    down = false
    registry.push(...(await gateway.attempt("Ranch"))!)

    expect(names(await gateway.scopeTools(registry, USER))).toEqual(["web_fetch", "Ranch__query_knowledge", "Ranch__pin_agent"])
    expect(names(await gateway.scopeTools(registry, GUEST))).toEqual(["web_fetch", "Ranch__query_knowledge"])
  })

  test("when listing for the actor fails the turn gets no Ranch tools, not all of them", async () => {
    let failing = false
    const gateway = new TestGateway({
      Ranch: (params) => {
        if (failing) throw new Error("ECONNREFUSED")
        return ranchCatalogue(params)
      },
      jira: () => [{ name: "search" }],
    })
    const registry = [builtin("web_fetch"), ...(await gateway.connect(ranchCfg)), ...(await gateway.connect(jiraCfg))]

    failing = true
    expect(names(await gateway.scopeTools(registry, OWNER))).toEqual(["web_fetch", "jira__search"])

    // And a tool the model names anyway is not sent.
    const deleteAgent = registry.find((t) => t.name === "Ranch__delete_agent")!
    const result = (await deleteAgent.execute({}, ctxOf(OWNER))) as { error: string }
    expect(result.error).toBe("Ranch is not reachable right now.")
    expect(gateway.clients.get("Ranch")!.calls).toEqual([])

    // A failure is not remembered for a minute: the next turn asks again.
    failing = false
    expect(names(await gateway.scopeTools(registry, OWNER))).toEqual([
      "web_fetch",
      "Ranch__query_knowledge",
      "Ranch__list_agents",
      "Ranch__delete_agent",
      "jira__search",
    ])
  })

  test("the cache does not grow with every token it has seen", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    for (let i = 0; i < 450; i++) await gateway.scopeTools(registry, { kind: "person", token: `tok-${i}` })

    const server = (gateway as unknown as { statics: Map<string, { catalogues: Map<string, unknown> }> }).statics.get("Ranch")!
    expect(server.catalogues.size).toBeLessThanOrEqual(200)
  })
})

// CLEAN-236. Another agent's question is a fourth kind of actor, and a call
// made in a hub conversation says which one (ranch
// `specs/033-identity-boundaries/contracts/handover.md` §3).
describe("a colleague's question", () => {
  const HANDOVER_A = "handover-token-of-question-a"
  const HANDOVER_B = "handover-token-of-question-b"
  const PEER_A: IActor = { kind: "peer", token: HANDOVER_A }
  const PEER_B: IActor = { kind: "peer", token: HANDOVER_B }

  test("is sent to Ranch as a peer with its token, on the list and on the call", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const registry = await gateway.connect(ranchCfg)
    const [tool] = await gateway.scopeTools(registry, PEER_A)
    await tool!.execute({}, ctxOf(PEER_A))

    const ranch = gateway.clients.get("Ranch")!
    expect(actorIn(ranch.lists.at(-1))).toEqual({ kind: "peer", token: HANDOVER_A })
    expect(actorIn(ranch.calls[0])).toEqual({ kind: "peer", token: HANDOVER_A })
  })

  test("two questions are two catalogues: neither is offered what Ranch listed for the other", async () => {
    // What a question may be passed on to depends on the person its chain
    // was started for, so one question's list says nothing about another's.
    const perQuestion = (params: Params): Descriptor[] => {
      const actor = actorIn(params)
      const base = [{ name: "query_knowledge" }]
      return actor?.kind === "peer" && actor.token === HANDOVER_A ? [...base, { name: "ask_agent" }] : base
    }
    const gateway = new TestGateway({ Ranch: (p) => (actorIn(p)?.kind === "trusted" ? [{ name: "query_knowledge" }, { name: "ask_agent" }] : perQuestion(p)) })
    const registry = await gateway.connect(ranchCfg)

    expect(names(await gateway.scopeTools(registry, PEER_A))).toEqual(["Ranch__query_knowledge", "Ranch__ask_agent"])
    expect(names(await gateway.scopeTools(registry, PEER_B))).toEqual(["Ranch__query_knowledge"])
    // And asked once each, not once for "a peer".
    expect(gateway.clients.get("Ranch")!.lists.map(actorIn)).toEqual([SELF, PEER_A, PEER_B])
  })

  test("never reaches a server that is not Ranch's own", async () => {
    const gateway = new TestGateway({ jira: () => [{ name: "search" }] })
    const [tool] = await gateway.connect(jiraCfg)
    await tool!.execute({ q: "x" }, { ...ctxOf(PEER_A), from: "peer:connection-1:ctx-1", channel: "bridle" })

    const jira = gateway.clients.get("jira")!
    expect(jira.calls).toEqual([{ name: "search", arguments: { q: "x" } }])
    expect(JSON.stringify([jira.lists, jira.calls])).not.toContain(HANDOVER_A)
  })
})

describe("_meta[\"ranch/turn\"]", () => {
  const turnIn = (params: Params) => params?._meta?.["ranch/turn"]

  test("a call made in a hub conversation says which one", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect(ranchCfg)
    await tool!.execute({}, { ...ctxOf(USER), from: "user-7", channel: "bridle" })

    expect(gateway.clients.get("Ranch")!.calls[0]!._meta).toEqual({
      "ranch/actor": { kind: "person", token: USER_TOKEN },
      "ranch/turn": { client: "user-7" },
    })
  })

  test("a turn that did not come over the hub names none: a messenger, a job of the agent's own, a worker", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect(ranchCfg)
    await tool!.execute({}, { ...ctxOf(GUEST), from: "42", channel: "telegram" })
    await tool!.execute({}, { ...ctxOf(SELF), from: "cron", channel: "internal" })
    // A delegated worker runs on the internal channel under its parent's from-id.
    await tool!.execute({}, { ...ctxOf(USER), from: "user-7", channel: "internal" })
    await tool!.execute({}, { ...ctxOf(GUEST), channel: "bridle" })

    expect(gateway.clients.get("Ranch")!.calls.map(turnIn)).toEqual([undefined, undefined, undefined, undefined])
  })

  test("is not sent on tools/list, and never to another server", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue, jira: () => [{ name: "search" }] })
    const registry = [...(await gateway.connect(ranchCfg)), ...(await gateway.connect(jiraCfg))]
    await gateway.scopeTools(registry, USER)
    const search = registry.find((t) => t.name === "jira__search")!
    await search.execute({}, { ...ctxOf(USER), from: "user-7", channel: "bridle" })

    expect(gateway.clients.get("Ranch")!.lists.map(turnIn)).toEqual([undefined, undefined])
    expect(gateway.clients.get("jira")!.calls[0]!._meta).toBeUndefined()
  })

  test("cannot be set through the tool's arguments", async () => {
    const gateway = new TestGateway({ Ranch: oldRanchCatalogue })
    const [tool] = await gateway.connect(ranchCfg)
    const forged = { _meta: { "ranch/turn": { client: "admin" } }, "ranch/turn": { client: "admin" } }
    await tool!.execute(forged, { ...ctxOf(GUEST), from: "share-visitor-7", channel: "bridle" })

    expect(turnIn(gateway.clients.get("Ranch")!.calls[0])).toEqual({ client: "share-visitor-7" })
  })
})
