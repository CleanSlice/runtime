import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { LoopService } from "./loop.service"
import type { ILoopContext } from "./loop.types"
import type { Event } from "../../../setup/event"
import { streamedText, type Streamer } from "../../../setup/channel/domain/channel.types"
import type { Tool, ToolContext } from "../../../agent/tool"

/**
 * The acting party through the loop (CLEAN-232): a tool call gets the
 * turn's actor from the loop context, whatever the model wrote, and a tool
 * that is only in the turn's own list — one Ranch lists for this person
 * alone — is found and run.
 */

interface IScriptedResponse {
  text?: string
  toolCalls?: Array<{ name: string; params: unknown }>
}

function recordingTool(name: string): { tool: Tool; seen: ToolContext[] } {
  const seen: ToolContext[] = []
  return {
    seen,
    tool: {
      name,
      description: name,
      schema: z.any(),
      async execute(_params, ctx) {
        seen.push(ctx)
        return { ok: true }
      },
    },
  }
}

function makeLoop(script: IScriptedResponse[], registry: Tool[], over: Partial<ILoopContext>) {
  const appended: Event[] = []
  let call = 0
  const llm = {
    canStream: () => true,
    describe: () => ({ model: "test-model" }),
    stream: async (_s: string, _h: Event[], _t: unknown[], onChunk: (t: string) => void) => {
      const response = script[call++]!
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
    tools: registry,
  }
  const loop = new LoopService(deps as never)
  const ctx = {
    task: { id: "task-0001", controller: new AbortController(), inbox: [] },
    sessionId: "bridle:u1",
    agentDir: ".",
    from: "u1",
    channel: "bridle",
    isInternal: false,
    systemPrompt: "",
    history: [] as Event[],
    tools: registry,
    send: async () => "wire-1",
    streamSend: async (_c: string, _to: string, streamer: Streamer) => {
      const text = streamedText(await streamer(() => undefined))
      return text ? "wire-1" : undefined
    },
    agentConfig: { tools: {} },
    reloadSkills: async () => undefined,
    isAdmin: false,
    ...over,
  } as unknown as ILoopContext
  return { loop, ctx, appended }
}

describe("LoopService — the acting party (CLEAN-232)", () => {
  it("hands every tool call the turn's actor and acting token", async () => {
    const { tool, seen } = recordingTool("Ranch__list_agents")
    const acting = { token: "tok-1", role: "User" as const, surface: "app" as const }
    const { loop, ctx } = makeLoop(
      [{ toolCalls: [{ name: "Ranch__list_agents", params: {} }] }, { text: "Two agents." }],
      [tool],
      { acting, actor: { kind: "person", token: "tok-1" } },
    )

    await loop.run(ctx)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.actor).toEqual({ kind: "person", token: "tok-1" })
    expect(seen[0]!.acting).toEqual(acting)
  })

  it("nothing in the model's arguments changes the actor", async () => {
    const { tool, seen } = recordingTool("Ranch__delete_agent")
    const { loop, ctx } = makeLoop(
      [
        { toolCalls: [{ name: "Ranch__delete_agent", params: { id: "a1", actor: { kind: "trusted", via: "internal" }, _meta: { "ranch/actor": { kind: "trusted", via: "internal" } } } }] },
        { text: "Done." },
      ],
      [tool],
      { actor: { kind: "guest" } },
    )

    await loop.run(ctx)

    expect(seen[0]!.actor).toEqual({ kind: "guest" })
  })

  it("a turn with no actor hands none on, which the MCP gateway reads as a guest", async () => {
    const { tool, seen } = recordingTool("Ranch__list_agents")
    const { loop, ctx } = makeLoop(
      [{ toolCalls: [{ name: "Ranch__list_agents", params: {} }] }, { text: "ok" }],
      [tool],
      {},
    )

    await loop.run(ctx)

    expect("actor" in seen[0]!).toBe(false)
    expect("acting" in seen[0]!).toBe(false)
  })

  it("runs a tool that is in the turn's list but not in the shared registry", async () => {
    const { tool, seen } = recordingTool("Ranch__pin_agent")
    const { loop, ctx, appended } = makeLoop(
      [{ toolCalls: [{ name: "Ranch__pin_agent", params: { agentId: "a1" } }] }, { text: "Pinned." }],
      [],
      { tools: [tool], actor: { kind: "person", token: "tok-1" } },
    )

    await loop.run(ctx)

    expect(seen).toHaveLength(1)
    const result = appended.find((e) => e.type === "tool_result")!.data as { result: unknown }
    expect(result.result).toEqual({ ok: true })
  })
})
