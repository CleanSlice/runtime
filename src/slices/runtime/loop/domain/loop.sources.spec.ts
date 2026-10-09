import { describe, expect, it } from "bun:test"
import { LoopService } from "./loop.service"
import type { ILoopContext, ISource } from "./loop.types"
import type { Event } from "../../../setup/event"
import type { Tool } from "../../../agent/tool"
import { z } from "zod"

/**
 * A source a tool consulted reaches the person as a numbered citation under
 * the bubble that used it (CLEAN-138). The loop numbers what the tools
 * declared, tells the model which numbers exist, checks what the model
 * wrote against that list once a bubble is complete, and publishes the
 * result — but only for a client that said it can draw it.
 */

interface IScriptedResponse {
  text?: string
  toolCalls?: Array<{ name: string; params: unknown }>
  stopReason?: string
}

const legal: ISource = { kind: "knowledge", id: "src-1", name: "Contract 2025.pdf", knowledgeId: "k1", knowledgeName: "Legal" }
const site: ISource = { kind: "web", url: "https://example.com/page", title: "Example" }

/** A tool whose result declares its sources in the contract shape — what Ranch's `query_knowledge` does over MCP. */
function lookupTool(name: string, sources: ISource[]): Tool {
  return {
    name,
    description: "scripted lookup",
    schema: z.any(),
    async execute() {
      return { answer: "…", sources }
    },
  }
}

interface ISourcesCall {
  messageId: string
  text: string
  sources: ISource[]
}

function makeLoop(script: IScriptedResponse[], opts: { streams?: boolean; citeSources?: boolean; tools?: Tool[] } = {}) {
  const { streams = true, citeSources = true, tools = [] } = opts
  const appended: Event[] = []
  let call = 0
  const llm = {
    canStream: () => streams,
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

  let bubble = 0
  const sent: string[] = []
  const sourcesSent: ISourcesCall[] = []
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
    // Stands in for the bridle repository: `send` mints a wire id like the
    // real one does, and a streamed bubble has an id only when it had text.
    send: async (text: string) => { sent.push(text); return `wire-${++bubble}` },
    streamSend: async (_c: string, _to: string, streamer: (onChunk: (t: string) => void) => Promise<string>) => {
      const text = await streamer(() => undefined)
      if (text) sent.push(text)
      return text ? `wire-${++bubble}` : undefined
    },
    agentConfig: {},
    reloadSkills: async () => undefined,
    isAdmin: true,
    citeSources,
    sendSources: (messageId: string, text: string, sources: ISource[]) => { sourcesSent.push({ messageId, text, sources }) },
  } as unknown as ILoopContext

  return { loop, ctx, appended, sent, sourcesSent }
}

const assistantEvents = (events: Event[]) => events.filter((e) => e.type === "assistant")
const toolResults = (events: Event[]) => events.filter((e) => e.type === "tool_result")

interface IAssistantData {
  text: string
  messages?: Array<{ id: string; text: string; ts: number }>
  sources?: Array<{ messageId: string; sources: ISource[] }>
}

describe("LoopService — sources an answer cites", () => {
  it("validates the bubble, publishes its sources and stores them on the turn", async () => {
    const { loop, ctx, appended, sourcesSent, sent } = makeLoop(
      [
        { toolCalls: [{ name: "query_knowledge", params: { q: "terms" } }] },
        { text: "A [^1] B [^7]" },
      ],
      { tools: [lookupTool("query_knowledge", [legal])] },
    )

    await loop.run(ctx)

    // The unknown [^7] is gone; the person's bubble carries the corrected text.
    expect(sent).toEqual(["A [^1] B"])
    expect(sourcesSent).toEqual([{ messageId: "wire-1", text: "A [^1] B", sources: [legal] }])

    const data = assistantEvents(appended)[0].data as IAssistantData
    expect(data.text).toBe("A [^1] B")
    expect(data.messages).toEqual([{ id: "wire-1", text: "A [^1] B", ts: expect.any(Number) }])
    expect(data.sources).toEqual([{ messageId: "wire-1", sources: [legal] }])
  })

  it("tells the model which numbers it may cite — in its copy of the result, not in the transcript", async () => {
    const { loop, ctx, appended } = makeLoop(
      [
        { toolCalls: [{ name: "query_knowledge", params: {} }] },
        { text: "Done [^1]." },
      ],
      { tools: [lookupTool("query_knowledge", [legal, site])] },
    )

    await loop.run(ctx)

    const stored = toolResults(appended)[0].data as { result: Record<string, unknown> }
    expect(stored.result).toEqual({ answer: "…", sources: [legal, site] })

    const forModel = toolResults(ctx.history)[0].data as { result: Record<string, unknown> }
    expect(forModel.result.citations).toBe(
      "Sources you may cite: [^1] «Contract 2025.pdf» (knowledge: Legal) · [^2] https://example.com/page (web)",
    )
  })

  it("adds nothing and strips the markers for a client that cannot draw sources", async () => {
    const { loop, ctx, appended, sourcesSent, sent } = makeLoop(
      [
        { toolCalls: [{ name: "query_knowledge", params: {} }] },
        { text: "A [^1] B [^7]" },
      ],
      { tools: [lookupTool("query_knowledge", [legal])], citeSources: false },
    )

    await loop.run(ctx)

    expect(sourcesSent).toEqual([])
    expect(sent).toEqual(["A B"])
    const data = assistantEvents(appended)[0].data as IAssistantData
    expect(data.text).toBe("A B")
    expect(data.sources).toBeUndefined()
    const forModel = toolResults(ctx.history)[0].data as { result: Record<string, unknown> }
    expect(forModel.result.citations).toBeUndefined()
  })

  it("numbers every bubble from 1, and keeps one turn-wide number for the model", async () => {
    const { loop, ctx, appended, sourcesSent } = makeLoop(
      [
        { toolCalls: [{ name: "lookup_a", params: {} }] },
        // Bubble 1 cites the first lookup, then goes on to a second one …
        { text: "See [^1].", toolCalls: [{ name: "lookup_b", params: {} }] },
        // … whose source is [^2] for the model; the bubble renumbers it.
        { text: "Also [^1] and [^2]." },
      ],
      { tools: [lookupTool("lookup_a", [legal]), lookupTool("lookup_b", [site, legal])] },
    )

    await loop.run(ctx)

    expect(sourcesSent).toEqual([
      { messageId: "wire-1", text: "See [^1].", sources: [legal] },
      { messageId: "wire-2", text: "Also [^1] and [^2].", sources: [legal, site] },
    ])
    // The second lookup returned a source the turn already knew: same number.
    const secondForModel = toolResults(ctx.history)[1].data as { result: Record<string, unknown> }
    expect(secondForModel.result.citations).toBe(
      "Sources you may cite: [^2] https://example.com/page (web) · [^1] «Contract 2025.pdf» (knowledge: Legal)",
    )
    const data = assistantEvents(appended)[0].data as IAssistantData
    expect(data.sources).toEqual([
      { messageId: "wire-1", sources: [legal] },
      { messageId: "wire-2", sources: [legal, site] },
    ])
  })

  it("publishes nothing for a bubble that cites nothing", async () => {
    const { loop, ctx, appended, sourcesSent } = makeLoop(
      [
        { toolCalls: [{ name: "query_knowledge", params: {} }] },
        { text: "Nothing to cite here." },
      ],
      { tools: [lookupTool("query_knowledge", [legal])] },
    )

    await loop.run(ctx)

    expect(sourcesSent).toEqual([])
    const data = assistantEvents(appended)[0].data as IAssistantData
    expect(data.sources).toBeUndefined()
  })

  it("checks a non-streamed turn once, over the whole text, under the id `send` minted", async () => {
    const { loop, ctx, appended, sourcesSent, sent } = makeLoop(
      [
        { toolCalls: [{ name: "query_knowledge", params: {} }] },
        { text: "First [^2]. Then [^9] and [^1]." },
      ],
      { tools: [lookupTool("query_knowledge", [legal, site])], streams: false },
    )

    await loop.run(ctx)

    expect(sent).toEqual(["First [^1]. Then and [^2]."])
    expect(sourcesSent).toEqual([{ messageId: "wire-1", text: "First [^1]. Then and [^2].", sources: [site, legal] }])
    const data = assistantEvents(appended)[0].data as IAssistantData
    expect(data.text).toBe("First [^1]. Then and [^2].")
    expect(data.sources).toEqual([{ messageId: "wire-1", sources: [site, legal] }])
  })
})
