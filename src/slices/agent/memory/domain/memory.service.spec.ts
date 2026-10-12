import { describe, expect, test } from "bun:test"
import { MemoryService } from "./memory.service"
import type { IMemoryGateway } from "./memory.gateway"
import type { Event } from "../../../setup/event"
import { InstinctService } from "../../instinct/domain/instinct.service"
import type { IInstinctGateway } from "../../instinct/domain/instinct.gateway"
import type { IInstinct } from "../../instinct/domain/instinct.types"
import { DEFAULT_INSTINCT_CONFIG } from "../../instinct/domain/instinct.types"

function memoryGateway() {
  let memoryFile = "# Memory\n"
  const gw: IMemoryGateway = {
    insert: () => {},
    search: () => [],
    appendDaily: () => {},
    readRecentDaily: () => undefined,
    readMemoryFile: () => memoryFile,
    writeMemoryFile: (c) => { memoryFile = c },
    enforceMdLimits: () => [],
  }
  return { gw, read: () => memoryFile }
}

function instinctService() {
  const store = new Map<string, IInstinct>()
  const gw: IInstinctGateway = {
    list: () => [...store.values()],
    write: (i) => { store.set(i.id, i) },
    remove: (id) => { store.delete(id) },
    readLastDecay: () => undefined,
    writeLastDecay: () => {},
    writeSkill: () => "/x",
  }
  const service = new InstinctService(gw, DEFAULT_INSTINCT_CONFIG)
  service.load()
  // The slice of InstinctModule the memory review needs.
  const s = { enabled: true, list: () => service.list(), applyReview: (items: Parameters<InstinctService["applyReview"]>[0]) => service.applyReview(items) }
  return { s, store }
}

/** An aux LLM that answers the review with the given JSON text. */
function llmAnswering(text: string) {
  const prompts: string[] = []
  return {
    prompts,
    llm: {
      auxComplete: async (system: string) => { prompts.push(system); return { text } },
    },
  }
}

const events: Event[] = [
  { id: "e1", type: "user", ts: 1, data: { text: "list the agents", from: "admin" } },
  { id: "e2", type: "assistant", ts: 2, data: { text: "Here are 40 lines of agent details…" } },
  { id: "e3", type: "user", ts: 3, data: { text: "shorter next time, just names. And never restart an agent without asking me.", from: "admin" } },
]

describe("memory review feeds the instinct store (CLEAN-150 US3)", () => {
  test("review output in instinct shape creates behaviours; an explicit admin rule is pinned at core", async () => {
    const { gw } = memoryGateway()
    const { s, store } = instinctService()
    const { llm, prompts } = llmAnswering(JSON.stringify({
      facts: [],
      instincts: [
        { kind: "new", trigger: "listing agents", action: "names only, no details", source: "correction", evidence: [{ ref: "session:bridle:admin#e3", note: "shorter next time" }] },
        { kind: "new", trigger: "restarting an agent", action: "ask the operator for confirmation first", source: "explicit-rule", evidence: [{ ref: "session:bridle:admin#e3" }] },
      ],
    }))
    const memory = new MemoryService(gw, { enabled: true, everyTurns: 1 }, s)
    await memory.reviewNow("bridle:admin", llm as never, events)

    expect(store.size).toBe(2)
    const rule = [...store.values()].find(i => i.source === "explicit-rule")!
    expect(rule.pinned).toBe(true)
    expect(rule.confidence).toBe(0.9)
    expect([...store.values()].find(i => i.source === "correction")!.confidence).toBe(0.6)
    expect(prompts[0]).toContain('"correction"')
    expect(prompts[0]).toContain("KNOWN INSTINCTS")
  })

  test("[fact] lines still land in MEMORY.md under ## Learned", async () => {
    const { gw, read } = memoryGateway()
    const { s } = instinctService()
    const { llm } = llmAnswering(JSON.stringify({ facts: ["[fact] The operator's timezone is Europe/Berlin"], instincts: [] }))
    const memory = new MemoryService(gw, { enabled: true, everyTurns: 1 }, s)
    await memory.reviewNow("s", llm as never, events)
    expect(read()).toContain("## Learned")
    expect(read()).toContain("Europe/Berlin")
  })

  test("NOTHING and malformed output leave everything untouched", async () => {
    const { gw, read } = memoryGateway()
    const { s, store } = instinctService()
    const memory = new MemoryService(gw, { enabled: true, everyTurns: 1 }, s)
    await memory.reviewNow("s", llmAnswering("NOTHING").llm as never, events)
    await memory.reviewNow("s", llmAnswering("{ not json").llm as never, events)
    expect(store.size).toBe(0)
    expect(read()).toBe("# Memory\n")
  })
})
