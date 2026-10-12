import { describe, expect, test } from "bun:test"
import { CompactionService } from "./compaction.service"
import { SessionService } from "./session.service"
import type { ISessionGateway } from "./session.gateway"
import type { Event } from "../../../setup/event"

function memorySession(initial: Event[]) {
  let events = [...initial]
  const gateway: ISessionGateway = {
    append: async (_id, e) => { events.push(e) },
    read: async () => events,
    rewrite: async (_id, next) => { events = [...next] },
  }
  return { service: new SessionService(gateway), read: () => events }
}

const archivist = { complete: async () => ({ text: "ARCHIVE" }) }

function events(n: number): Event[] {
  const out: Event[] = []
  for (let i = 0; i < n; i++) {
    out.push({ id: `u${i}`, type: "user", ts: i * 2, data: { text: `message ${i} ${"x".repeat(200)}`, from: "u" } })
    out.push({ id: `c${i}`, type: "tool_call", ts: i * 2 + 1, data: { name: i % 2 ? "http" : "exec", params: {} } })
  }
  return out
}

/** Thresholds: 10 events / 2 kB, keep 4, budget 100 kB with the hard limit at 90 %. */
function service(s: SessionService) {
  return new CompactionService(s, 10, 4, 2_000, { contextBudgetChars: 100_000, hardLimitPct: 90 })
}

describe("compaction at task boundaries (CLEAN-150 US4)", () => {
  test("over threshold with no task in flight compacts with reason boundary and an in-flight note", async () => {
    const { service: s, read } = memorySession(events(12))
    await service(s).compact("s", archivist, { reason: "boundary", inFlight: false, pending: ["reply to the second question"] })
    const first = read()[0]!
    expect(first.type).toBe("summary")
    const data = first.data as { reason: string; inFlight: { goal: string; done: string[]; pending: string[] } }
    expect(data.reason).toBe("boundary")
    expect(data.inFlight.goal).toContain("message 11")
    expect(data.inFlight.done).toEqual(["http", "exec", "http"])
    expect(data.inFlight.pending).toEqual(["reply to the second question"])
    expect(read().length).toBe(5)
  })

  test("over threshold with a task in flight is deferred below the hard limit", async () => {
    const { service: s, read } = memorySession(events(12))
    await service(s).compact("s", archivist, { reason: "boundary", inFlight: true })
    expect(read().length).toBe(24)
    expect(read()[0]!.type).toBe("user")
  })

  test("past the hard limit a task in flight no longer defers; the reason says so", async () => {
    const { service: s, read } = memorySession(events(300))   // ≈ 70 kB
    const svc = new CompactionService(s, 10, 4, 2_000, { contextBudgetChars: 60_000, hardLimitPct: 90 })
    await svc.compact("s", archivist, { reason: "boundary", inFlight: true })
    expect(read()[0]!.type).toBe("summary")
    expect((read()[0]!.data as { reason: string }).reason).toBe("hard-limit")
  })

  test("an operator request compacts regardless of thresholds", async () => {
    const { service: s, read } = memorySession(events(4))     // 8 events, under both thresholds
    await service(s).compact("s", archivist, { reason: "operator", force: true })
    expect(read()[0]!.type).toBe("summary")
    expect((read()[0]!.data as { reason: string }).reason).toBe("operator")
  })

  test("the last compaction per session is remembered with its reason", async () => {
    const { service: s } = memorySession(events(12))
    const svc = service(s)
    expect(svc.lastCompaction("s")).toBeUndefined()
    await svc.compact("s", archivist, { reason: "idle" })
    expect(svc.lastCompaction("s")?.reason).toBe("idle")
  })

  test("legacy call without options behaves as a boundary compaction", async () => {
    const { service: s, read } = memorySession(events(12))
    await service(s).compact("s", archivist)
    expect((read()[0]!.data as { reason: string }).reason).toBe("boundary")
  })
})
