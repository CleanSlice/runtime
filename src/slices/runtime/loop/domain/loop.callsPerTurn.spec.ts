import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { callsPerTurnLimit, LoopService } from "./loop.service"
import type { ILoopContext } from "./loop.types"
import type { Event } from "../../../setup/event"
import { streamedText, type Streamer } from "../../../setup/channel/domain/channel.types"
import type { Tool } from "../../../agent/tool"

/**
 * `tools.callsPerTurn` (CLEAN-202): one tool may be called only so many
 * times in a turn. On 2026-11-02 a "which trim has X" question ran sixteen
 * `query_knowledge` searches in a minute and answered nothing before the
 * person gave up. Past the cap the call is not executed and the model gets
 * a result — not an error — telling it to answer from what it has.
 */

interface IScriptedResponse {
  text?: string
  toolCalls?: Array<{ name: string; params: unknown }>
}

/** A tool that counts how often it really ran. */
function countingTool(name: string): { tool: Tool; runs: () => number } {
  let n = 0
  return {
    runs: () => n,
    tool: {
      name,
      description: "scripted lookup",
      schema: z.any(),
      async execute() {
        n += 1
        return { passages: [`passage ${n}`] }
      },
    },
  }
}

function makeLoop(script: IScriptedResponse[], tools: Tool[], callsPerTurn?: Record<string, number>) {
  const appended: Event[] = []
  let call = 0
  const llm = {
    canStream: () => true,
    describe: () => ({ model: "test-model" }),
    stream: async (_s: string, _h: Event[], _t: unknown[], onChunk: (t: string) => void) => {
      const response = script[call++]
      if (response.text) onChunk(response.text)
      return response
    },
    complete: async () => script[call++],
  }
  const deps = {
    llm,
    session: { append: async (_id: string, event: Event) => { appended.push(event) } },
    activity: { updateStep: () => undefined },
    usage: { add: () => undefined },
    voice: { isEnabled: () => false },
    channel: { isBridleDebugEnabled: () => false },
    tools,
  }
  const loop = new LoopService(deps as never)
  const ctx = {
    task: { id: "task-0001", controller: new AbortController(), inbox: [] },
    sessionId: "bridle:admin",
    agentDir: ".",
    from: "admin",
    channel: "bridle",
    isInternal: false,
    systemPrompt: "",
    history: [] as Event[],
    tools,
    send: async () => "wire-1",
    streamSend: async (_c: string, _to: string, streamer: Streamer) => {
      const text = streamedText(await streamer(() => undefined))
      return text ? "wire-1" : undefined
    },
    agentConfig: { tools: callsPerTurn ? { callsPerTurn } : {} },
    reloadSkills: async () => undefined,
    isAdmin: true,
  } as unknown as ILoopContext
  return { loop, ctx, appended }
}

const toolResults = (events: Event[]) =>
  events.filter((e) => e.type === "tool_result").map((e) => e.data as { result: Record<string, unknown>; blocked?: true })

const search = (q: string) => ({ name: "Documents__query_knowledge", params: { query: q } })

describe("LoopService — tools.callsPerTurn", () => {
  it("stops executing a tool past its cap and hands the model a result, not an error", async () => {
    const { tool, runs } = countingTool("Documents__query_knowledge")
    const { loop, ctx, appended } = makeLoop(
      [
        { toolCalls: [search("one"), search("two")] },
        { toolCalls: [search("three")] },
        { text: "The 2.5 S Premium and the 2.5 Turbo Premium Plus." },
      ],
      [tool],
      { query_knowledge: 2 },
    )

    await loop.run(ctx)

    // Two searches ran; the third was refused without reaching the tool.
    expect(runs()).toBe(2)
    const results = toolResults(appended)
    expect(results).toHaveLength(3)
    expect(results[2].blocked).toBe(true)
    expect(results[2].result.limit_reached).toBe(true)
    expect(results[2].result.calls).toBe(2)
    expect(String(results[2].result.note)).toContain("Answer from the results you already have")
    expect(results[2].result.error).toBeUndefined()
    // The turn still ends with the answer, not with "too many errors".
    const assistant = appended.filter((e) => e.type === "assistant")
    expect(assistant).toHaveLength(1)
    expect((assistant[0].data as { text: string }).text).toContain("2.5 S Premium")
  })

  it("caps nothing when no cap is configured", async () => {
    const { tool, runs } = countingTool("Documents__query_knowledge")
    const { loop, ctx } = makeLoop(
      [
        { toolCalls: [search("one"), search("two"), search("three")] },
        { text: "Done." },
      ],
      [tool],
    )

    await loop.run(ctx)

    expect(runs()).toBe(3)
  })

  it("counts per tool, so a cap on one tool leaves another alone", async () => {
    const lookup = countingTool("Documents__query_knowledge")
    const listing = countingTool("Documents__list_knowledge_documents")
    const { loop, ctx } = makeLoop(
      [
        { toolCalls: [search("one"), { name: listing.tool.name, params: {} }, search("two"), { name: listing.tool.name, params: {} }] },
        { text: "Done." },
      ],
      [lookup.tool, listing.tool],
      { query_knowledge: 1 },
    )

    await loop.run(ctx)

    expect(lookup.runs()).toBe(1)
    expect(listing.runs()).toBe(2)
  })

  it("starts the count afresh on the next turn", async () => {
    const { tool, runs } = countingTool("Documents__query_knowledge")
    const { loop, ctx } = makeLoop(
      [
        { toolCalls: [search("one")] },
        { text: "First." },
        { toolCalls: [search("two")] },
        { text: "Second." },
      ],
      [tool],
      { query_knowledge: 1 },
    )

    await loop.run(ctx)
    await loop.run(ctx)

    expect(runs()).toBe(2)
  })
})

describe("callsPerTurnLimit", () => {
  it("matches the full MCP name first, then the bare tool name", () => {
    expect(callsPerTurnLimit({ query_knowledge: 8 }, "Documents__query_knowledge")).toBe(8)
    expect(callsPerTurnLimit({ Documents__query_knowledge: 3, query_knowledge: 8 }, "Documents__query_knowledge")).toBe(3)
    expect(callsPerTurnLimit({ query_knowledge: 8 }, "query_knowledge")).toBe(8)
    expect(callsPerTurnLimit({ query_knowledge: 8 }, "exec")).toBeUndefined()
    expect(callsPerTurnLimit({}, "Documents__query_knowledge")).toBeUndefined()
  })
})
