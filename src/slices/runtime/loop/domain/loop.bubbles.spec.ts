import { describe, expect, it } from "bun:test"
import { LoopService } from "./loop.service"
import type { ILoopContext } from "./loop.types"
import type { Event } from "../../../setup/event"
import { streamedInterim, streamedText, type Streamer } from "../../../setup/channel/domain/channel.types"

/**
 * A turn on a streaming channel reaches the person as several bubbles — the
 * text of every iteration goes out under its own message id — but it is
 * stored as ONE assistant event. Without the boundaries a transcript replay
 * glued them: "Let me check:" + "Done!" came back as "Let me check:Done!"
 * (CLEAN-102). The event keeps `text` whole for the model and carries the
 * bubbles as display-only `messages`.
 */

interface IScriptedResponse {
  text?: string
  toolCalls?: Array<{ name: string; params: unknown }>
  stopReason?: string
}

function makeLoop(script: IScriptedResponse[], streams = true) {
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
    tools: [],
  }
  const loop = new LoopService(deps as never)

  let bubble = 0
  const sent: string[] = []
  // What each bubble's streamer handed back, as the bridle repository would
  // see it: the text, and whether the loop called it interim (CLEAN-189).
  const streamed: Array<{ text: string; interim: boolean }> = []
  const ctx = {
    task: { id: "task-0001", controller: new AbortController(), inbox: [] },
    sessionId: "bridle:admin",
    agentDir: ".",
    from: "admin",
    channel: "bridle",
    isInternal: false,
    systemPrompt: "",
    history: [] as Event[],
    tools: [],
    send: async (text: string) => { sent.push(text) },
    // Stands in for the bridle repository: a bubble, and therefore an id,
    // exists only when the iteration produced text.
    streamSend: async (_c: string, _to: string, streamer: Streamer) => {
      const result = await streamer(() => undefined)
      const text = streamedText(result)
      if (text) streamed.push({ text, interim: streamedInterim(result) })
      return text ? `wire-${++bubble}` : undefined
    },
    agentConfig: {},
    reloadSkills: async () => undefined,
    isAdmin: true,
  } as unknown as ILoopContext

  return { loop, ctx, appended, sent, streamed }
}

const assistantEvents = (events: Event[]) => events.filter((e) => e.type === "assistant")

describe("LoopService — bubbles of a streamed turn", () => {
  it("stores the turn once, with the bubbles the person saw", async () => {
    const { loop, ctx, appended } = makeLoop([
      { text: "Let me check:", toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "Done!" },
    ])

    await loop.run(ctx)

    const stored = assistantEvents(appended)
    expect(stored).toHaveLength(1)
    const data = stored[0].data as { text: string; messages: Array<{ id: string; text: string; ts: number }> }
    // The model-facing text is unchanged …
    expect(data.text).toBe("Let me check:Done!")
    // … and the replay can split it back where the person saw it split.
    expect(data.messages.map((m) => [m.id, m.text])).toEqual([
      ["wire-1", "Let me check:"],
      ["wire-2", "Done!"],
    ])
    expect(data.messages.every((m) => typeof m.ts === "number")).toBe(true)
  })

  it("marks the narration before a tool call as interim — on the wire and in the stored bubbles (CLEAN-189)", async () => {
    // Production, 2026-10-28: "I cannot provide a definitive list of 2026
    // CX-30 trims…" went out as a bubble while the agent went on to search
    // twice more and found the list. The person had already read a refusal.
    const { loop, ctx, appended, streamed } = makeLoop([
      { text: "Let me search for the 26MY CX-30 lineup.", toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "The 2026 CX-30 comes in eight trims." },
    ])

    await loop.run(ctx)

    // The channel is told which bubble was narration, at stream end.
    expect(streamed).toEqual([
      { text: "Let me search for the 26MY CX-30 lineup.", interim: true },
      { text: "The 2026 CX-30 comes in eight trims.", interim: false },
    ])
    // The stored boundaries carry it too, so a replay can fold it the same way.
    const data = assistantEvents(appended)[0].data as {
      text: string
      messages: Array<{ id: string; text: string; interim?: true }>
    }
    expect(data.messages.map((m) => [m.id, m.interim ?? false])).toEqual([
      ["wire-1", true],
      ["wire-2", false],
    ])
    // The model-facing text is still the whole turn.
    expect(data.text).toBe("Let me search for the 26MY CX-30 lineup.The 2026 CX-30 comes in eight trims.")
  })

  it("records nothing for an iteration that showed no bubble", async () => {
    const { loop, ctx, appended } = makeLoop([
      { toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "Done!" },
    ])

    await loop.run(ctx)

    const data = assistantEvents(appended)[0].data as { messages: Array<{ id: string }> }
    expect(data.messages.map((m) => m.id)).toEqual(["wire-1"])
  })

  it("leaves the event as it was on a channel that does not stream", async () => {
    const { loop, ctx, appended, sent } = makeLoop([{ text: "Hello" }], false)

    await loop.run(ctx)

    expect(assistantEvents(appended)[0].data).toEqual({ text: "Hello" })
    expect(sent).toEqual(["Hello"])
  })
})
