import { describe, expect, it } from "bun:test"
import { LoopService, NARRATION_HOLDBACK_CHARS } from "./loop.service"
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
  // The thinking steps the loop published, in order (CLEAN-197).
  const steps: Array<{ id: string; label: string; state: string }> = []
  const ctx = {
    sendThinking: (_turnId: string, step?: { id: string; label: string; state: string }) => { if (step) steps.push(step) },
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

  return { loop, ctx, appended, sent, streamed, steps }
}

/** A narration longer than the holdback: it streams, and folds at stream end. */
const LONG_NARRATION = "Let me search for the 26MY CX-30 lineup. ".repeat(9).trim()

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
    // … and the replay can split it back where the person saw it split: the
    // short narration never was a bubble (CLEAN-197), so it sits under the
    // id of the thinking step it became; the answer under its wire id.
    expect(data.messages.map((m) => [m.id, m.text])).toEqual([
      [expect.any(String), "Let me check:"],
      ["wire-1", "Done!"],
    ])
    expect(data.messages[0].id).not.toMatch(/^wire-/)
    expect(data.messages.every((m) => typeof m.ts === "number")).toBe(true)
  })

  it("a narration that outgrew the holdback streams and is marked interim at stream end (CLEAN-189)", async () => {
    // Production, 2026-10-28: "I cannot provide a definitive list of 2026
    // CX-30 trims…" went out as a bubble while the agent went on to search
    // twice more and found the list. The person had already read a refusal.
    expect(LONG_NARRATION.length).toBeGreaterThan(NARRATION_HOLDBACK_CHARS)
    const { loop, ctx, appended, streamed, steps } = makeLoop([
      { text: LONG_NARRATION, toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "The 2026 CX-30 comes in eight trims." },
    ])

    await loop.run(ctx)

    // The channel is told which bubble was narration, at stream end.
    expect(streamed).toEqual([
      { text: LONG_NARRATION, interim: true },
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
    expect(data.text).toBe(`${LONG_NARRATION}The 2026 CX-30 comes in eight trims.`)
    // Streamed narration is the channel's to fold; the loop adds no step of its own.
    expect(steps.filter((s) => s.label === LONG_NARRATION)).toHaveLength(0)
  })

  it("a short narration never opens a bubble: it is a thinking step before the tool steps, and an interim bubble on the stored turn (CLEAN-197)", async () => {
    // Production, 2026-10-29 21:24: "I'll pull the trim lineups for both
    // model years…" streamed as a message and then jumped into "Thought for
    // a moment" when stream_end said interim.
    const narration = "I'll pull the trim lineups for both model years to compare them accurately."
    const { loop, ctx, appended, streamed, steps } = makeLoop([
      { text: narration, toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "The 2026 CX-30 comes in eight trims." },
    ])

    await loop.run(ctx)

    // Nothing reached the channel for the narration — only the answer did.
    expect(streamed).toEqual([{ text: "The 2026 CX-30 comes in eight trims.", interim: false }])
    // The narration went out as the first step of the turn, before the tool's own step.
    expect(steps[0]).toMatchObject({ label: narration, state: "done" })
    expect(steps.findIndex((s) => s.label === "Missing tool")).toBeGreaterThan(0)
    // The stored turn still carries it as an interim bubble under the step's id, so a replay folds it the same way.
    const data = assistantEvents(appended)[0].data as {
      text: string
      messages: Array<{ id: string; text: string; interim?: true }>
    }
    expect(data.messages.map((m) => [m.id, m.text, m.interim ?? false])).toEqual([
      [steps[0].id, narration, true],
      ["wire-1", "The 2026 CX-30 comes in eight trims.", false],
    ])
    expect(data.text).toBe(`${narration}The 2026 CX-30 comes in eight trims.`)
  })

  it("a short answer with no tool calls is one whole bubble, not interim", async () => {
    const { loop, ctx, streamed, steps } = makeLoop([{ text: "It holds 13.2 gallons." }])

    await loop.run(ctx)

    expect(streamed).toEqual([{ text: "It holds 13.2 gallons.", interim: false }])
    expect(steps).toHaveLength(0)
  })

  it("sends the turn's text as the reply when every bubble was interim and the model ended silent (CLEAN-193)", async () => {
    // The answer arrived next to a tool call, so the console folded it into
    // the thinking block; the model then ended with nothing. Without this
    // the person reads no reply and a synchronous caller waits forever.
    const answer = "AFS is standard on 2.5 S Premium and 2.5 Turbo Premium Plus."
    const { loop, ctx, appended, sent, streamed } = makeLoop([
      { text: answer, toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "" },
    ])
    let replies = 0
    ctx.send = async (text: string) => { sent.push(text); return `reply-${++replies}` }

    await loop.run(ctx)

    // Short, so it was held back and never streamed (CLEAN-197) — it went
    // out as a thinking step; the stored turn still counts it as interim.
    expect(streamed).toEqual([])
    expect(sent).toEqual([answer])
    const data = assistantEvents(appended)[0].data as {
      text: string
      messages: Array<{ id: string; text: string; interim?: true }>
    }
    expect(data.messages.map((m) => [m.id, m.interim ?? false])).toEqual([
      [expect.any(String), true],
      ["reply-1", false],
    ])
    expect(data.text).toBe(answer)
  })

  it("does not repeat the reply when a real bubble followed the narration", async () => {
    const { loop, ctx, sent } = makeLoop([
      { text: "Let me check the deck.", toolCalls: [{ name: "missing_tool", params: {} }] },
      { text: "Eight trims." },
    ])

    await loop.run(ctx)

    expect(sent).toEqual([])
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
