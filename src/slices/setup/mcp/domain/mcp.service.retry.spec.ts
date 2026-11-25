import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { Tool } from "../../../agent/tool"
import { McpService, type IMcpClock } from "./mcp.service"
import { IMcpGateway, type IMcpReconnectResult } from "./mcp.gateway"
import { McpFetcher } from "./mcp.fetcher"
import type { IMcpServerConfig } from "./mcp.types"
import { LATER_DROP_MS, type IToolServerState, type IToolState } from "./toolState"

/**
 * The service keeps trying (CLEAN-245): one timer per server that is not
 * connected, a growing pause, and the tools put into the live registry the
 * moment the server answers. Time is a clock the spec moves by hand.
 */

const tool = (name: string): Tool => ({ name, description: name, schema: z.any(), execute: async () => null })

const START = Date.parse("2026-11-20T09:09:52.000Z")

class FakeClock implements IMcpClock {
  time = START
  private seq = 0
  private pending = new Map<number, { at: number; fn: () => void }>()
  now() {
    return this.time
  }
  set(fn: () => void, ms: number) {
    const id = ++this.seq
    this.pending.set(id, { at: this.time + ms, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clear(timer: ReturnType<typeof setTimeout>) {
    this.pending.delete(timer as unknown as number)
  }
  get waiting(): number[] {
    return [...this.pending.values()].map((t) => t.at - this.time).sort((a, b) => a - b)
  }
  /** Move time forward, running what falls due, in order, letting each settle. */
  async advance(ms: number) {
    const until = this.time + ms
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.pending.delete(due[0])
      this.time = due[1].at
      due[1].fn()
      await flush()
    }
    this.time = until
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A gateway whose servers the spec sets by hand; `attempt` answers from `answers`. */
class FakeGateway extends IMcpGateway {
  servers = new Map<string, IToolServerState>()
  answers = new Map<string, Array<Tool[] | null | "hang">>()
  attempted: string[] = []
  closed = false
  private listeners = new Set<() => void>()
  constructor(private readonly clock: FakeClock) {
    super()
  }
  put(name: string, state: IToolServerState["state"], attempts = state === "connected" ? 0 : 1) {
    const before = this.servers.get(name)
    this.servers.set(name, {
      name,
      state,
      since: before?.state === state ? before.since : new Date(this.clock.time).toISOString(),
      attempts,
    })
    for (const l of this.listeners) l()
  }
  async connect(_cfg: IMcpServerConfig): Promise<Tool[]> {
    return []
  }
  async reconnect(): Promise<IMcpReconnectResult | null> {
    return null
  }
  override attempt(name: string): Promise<Tool[] | null> {
    this.attempted.push(name)
    const next = this.answers.get(name)?.shift() ?? null
    if (next === "hang") return new Promise(() => undefined)
    if (next) this.put(name, "connected")
    else this.put(name, "retrying", (this.servers.get(name)?.attempts ?? 0) + 1)
    return Promise.resolve(next)
  }
  override status(): IToolServerState[] {
    return [...this.servers.values()]
  }
  override onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async closeAll(): Promise<void> {
    this.closed = true
  }
}

let clock: FakeClock
let gateway: FakeGateway
let service: McpService
let registry: Tool[]
let savedGrace: string | undefined

beforeEach(() => {
  savedGrace = process.env.MCP_START_GRACE_MS
  delete process.env.MCP_START_GRACE_MS
  delete process.env.MCP_RETRY_MAX_MS
  clock = new FakeClock()
  gateway = new FakeGateway(clock)
  service = new McpService(gateway, new McpFetcher(), clock)
  registry = [tool("web_fetch"), tool("jira__search")]
})
afterEach(async () => {
  await service.shutdown()
  if (savedGrace === undefined) delete process.env.MCP_START_GRACE_MS
  else process.env.MCP_START_GRACE_MS = savedGrace
})

const within = (ms: number, base: number) => ms >= base * 0.8 && ms <= base * 1.2

describe("a server that did not answer", () => {
  test("is tried again after about five seconds, and its tools go into the live registry", async () => {
    gateway.put("Documents", "retrying")
    gateway.answers.set("Documents", [[tool("Documents__search")]])
    service.bind(registry)
    const held = registry

    const [delay] = clock.waiting.filter((ms) => ms < 30_000)
    expect(within(delay!, 5_000)).toBe(true)

    await clock.advance(6_000)

    expect(gateway.attempted).toEqual(["Documents"])
    expect(registry).toBe(held)
    expect(registry.map((t) => t.name)).toEqual(["web_fetch", "jira__search", "Documents__search"])
  })

  test("the pause grows: 5, 10, 20, 40 seconds, then a minute for as long as it takes", async () => {
    gateway.put("Documents", "retrying")
    service.bind(registry)
    const pauses: number[] = []
    for (let i = 0; i < 7; i++) {
      const before = gateway.attempted.length
      const from = clock.time
      while (gateway.attempted.length === before) await clock.advance(500)
      pauses.push(clock.time - from)
    }
    const expected = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]
    pauses.forEach((ms, i) => expect(ms >= expected[i]! * 0.8 - 500 && ms <= expected[i]! * 1.2 + 500).toBe(true))
  })

  test("nothing is tried once it is connected", async () => {
    gateway.put("Documents", "retrying")
    gateway.answers.set("Documents", [[tool("Documents__search")]])
    service.bind(registry)
    await clock.advance(6_000)

    await clock.advance(600_000)
    expect(gateway.attempted).toHaveLength(1)
    expect(clock.waiting).toEqual([])
  })

  test("the tools it had before a drop are replaced, not doubled", async () => {
    registry.push(tool("Documents__search"), tool("Documents__old"))
    gateway.put("Documents", "retrying")
    gateway.answers.set("Documents", [[tool("Documents__search")]])
    service.bind(registry)

    await clock.advance(6_000)

    expect(registry.map((t) => t.name)).toEqual(["web_fetch", "jira__search", "Documents__search"])
  })

  test("a refused server gets no timer", async () => {
    gateway.put("Documents", "refused")
    service.bind(registry)

    await clock.advance(600_000)
    expect(gateway.attempted).toEqual([])
  })

  test("a server that drops later is picked up without anyone asking", async () => {
    gateway.put("Documents", "connected")
    service.bind(registry)
    await clock.advance(3_600_000)
    expect(clock.waiting).toEqual([])

    gateway.put("Documents", "retrying")
    gateway.answers.set("Documents", [null, [tool("Documents__search")]])
    await clock.advance(20_000)

    expect(gateway.attempted).toEqual(["Documents", "Documents"])
    expect(registry.some((t) => t.name === "Documents__search")).toBe(true)
  })

  test("a server taken out of the configuration is no longer tried", async () => {
    gateway.put("Documents", "retrying")
    service.bind(registry)
    expect(clock.waiting.some((ms) => ms < 30_000)).toBe(true)

    gateway.servers.delete("Documents")
    gateway.put("Ranch", "connected")

    expect(clock.waiting).toEqual([])
    await clock.advance(600_000)
    expect(gateway.attempted).toEqual([])
  })

  test("shutdown stops every timer", async () => {
    gateway.put("Documents", "retrying")
    gateway.put("Ranch", "retrying")
    service.bind(registry)
    expect(clock.waiting.length).toBeGreaterThan(0)

    await service.shutdown()

    expect(clock.waiting).toEqual([])
    expect(gateway.closed).toBe(true)
    await clock.advance(600_000)
    expect(gateway.attempted).toEqual([])
  })
})

describe("before a turn", () => {
  test("nothing missing: answers at once and tries nothing", async () => {
    gateway.put("Documents", "connected")
    service.bind(registry)
    await service.settle(3_000)
    expect(gateway.attempted).toEqual([])
  })

  test("a server that is back is in the registry before the turn reads it", async () => {
    gateway.put("Documents", "retrying", 4)
    gateway.answers.set("Documents", [[tool("Documents__search")]])
    service.bind(registry)

    await service.settle(3_000)

    expect(registry.some((t) => t.name === "Documents__search")).toBe(true)
    // The budget's own timer is gone, and so is the server's.
    expect(clock.waiting).toEqual([])
  })

  test("a server that does not answer holds the turn for the budget, no longer", async () => {
    gateway.put("Documents", "retrying")
    gateway.answers.set("Documents", ["hang"])
    service.bind(registry)

    let settled = false
    void service.settle(3_000).then(() => {
      settled = true
    })
    await clock.advance(2_999)
    expect(settled).toBe(false)
    await clock.advance(1)
    expect(settled).toBe(true)
  })

  test("a refused server is not tried", async () => {
    gateway.put("Documents", "refused")
    service.bind(registry)
    await service.settle(3_000)
    expect(gateway.attempted).toEqual([])
  })
})

describe("the phase", () => {
  test("connecting within the first minute, limited after it, ready when the server is back", async () => {
    const seen: string[] = []
    service.onState((s: IToolState) => seen.push(s.phase))
    gateway.put("Ranch", "connected")
    gateway.put("Documents", "retrying")
    service.bind(registry)

    expect(service.state()).toMatchObject({ phase: "connecting", startedAt: new Date(START).toISOString() })

    await clock.advance(61_000)
    expect(service.state().phase).toBe("limited")
    expect(Date.parse(service.state().since)).toBeGreaterThanOrEqual(START + 60_000)

    gateway.answers.set("Documents", [[tool("Documents__search")]])
    await clock.advance(120_000)
    expect(service.state()).toMatchObject({ phase: "ready" })
    expect(service.state().servers.map((s) => s.state)).toEqual(["connected", "connected"])

    expect(seen[0]).toBe("connecting")
    expect(seen).toContain("limited")
    expect(seen.at(-1)).toBe("ready")
  })

  test("a later drop is not a mark until it lasts fifteen seconds", async () => {
    gateway.put("Documents", "connected")
    service.bind(registry)
    await clock.advance(3_600_000)

    gateway.put("Documents", "retrying")
    gateway.answers.set("Documents", ["hang"])
    expect(service.state().phase).toBe("ready")

    await clock.advance(LATER_DROP_MS + 10)
    expect(service.state().phase).toBe("limited")
  })

  test("a listener that throws does not stop the others", async () => {
    const seen: string[] = []
    service.onState(() => {
      throw new Error("boom")
    })
    service.onState((s) => seen.push(s.phase))
    gateway.put("Documents", "retrying")
    service.bind(registry)
    expect(seen).toContain("connecting")
  })
})
