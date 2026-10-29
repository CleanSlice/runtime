import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { z } from "zod"
import { LoopService } from "./loop.service"
import type { ILoopContext } from "./loop.types"
import type { Event } from "../../../setup/event"
import type { Tool } from "../../../agent/tool"
import type { ModelResponse } from "../../../setup/llm/domain/llm.types"
import { TaskManager } from "../../../agent/task/domain/task.service"
import { TaskGateway } from "../../../agent/task/data/task.gateway"
import { AGENT_CONFIG_DEFAULTS } from "../../init/domain/init.types"

/** A scripted LLM: each call pops the next response; afterwards it says "done". */
function scriptedLlm(responses: ModelResponse[]) {
  const queue = [...responses]
  const calls: Array<{ history: Event[] }> = []
  return {
    calls,
    llm: {
      canStream: () => false,
      describe: () => ({ provider: "stub", model: "stub" }),
      complete: async (_system: string, history: Event[]) => {
        calls.push({ history: [...history] })
        return queue.shift() ?? { text: "done", stopReason: "end_turn" }
      },
      stream: async () => { throw new Error("not used") },
    },
  }
}

function recordingSession() {
  const events: Event[] = []
  return {
    events,
    session: {
      append: async (_id: string, e: Event) => { events.push(e) },
      read: async () => events,
      rewrite: async () => {},
      compactAsync: () => {},
      touch: () => {},
    },
  }
}

const execTool = (seen: unknown[]): Tool => ({
  name: "exec",
  description: "run",
  effect: "write",
  schema: z.object({ command: z.string() }),
  adminOnly: true,
  execute: async (params) => { seen.push(params); return { stdout: "ok\n" } },
})

function makeLoop(deps: { llm: unknown; session: unknown; tools: Tool[] }) {
  return new LoopService({
    llm: deps.llm as never,
    session: deps.session as never,
    activity: { updateStep: () => {}, set: () => {}, clear: () => {} } as never,
    usage: { add: () => {} } as never,
    voice: {} as never,
    channel: {} as never,
    tools: deps.tools,
  })
}

function makeCtx(agentDir: string, tools: Tool[], sent: string[]): ILoopContext {
  return {
    task: { id: "task-1", label: "t", sessionId: "s", taskSessionId: "s:task:1", startedAt: 0, status: "running", controller: new AbortController(), inbox: [], internal: true },
    sessionId: "internal:u",
    agentDir,
    from: "u",
    channel: "internal",
    isInternal: true,
    systemPrompt: "",
    history: [],
    tools,
    send: async (text) => { sent.push(text) },
    streamSend: async () => undefined,
    agentConfig: AGENT_CONFIG_DEFAULTS,
    reloadSkills: async () => {},
    isAdmin: true,
  }
}

describe("LoopService tool calls", () => {
  test("a tool call runs with the params the model gave and the final text is sent", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "loop-"))
    const seen: unknown[] = []
    const tools = [execTool(seen)]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "exec", params: { command: "ls" } }], stopReason: "tool_use" },
    ])
    const { session } = recordingSession()
    const sent: string[] = []

    await makeLoop({ llm, session, tools }).run(makeCtx(agentDir, tools, sent))

    expect(seen).toEqual([{ command: "ls" }])
    expect(sent).toEqual(["done"])
  })
})

describe("LoopService completion contract (CLEAN-150 US6)", () => {
  test("a turn does not end while a delegated worker runs; past the budget it is cancelled and reported", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "delegate-loop-"))
    const tasks = new TaskManager(new TaskGateway())
    const { llm, calls } = scriptedLlm([
      { text: "All five reports are ready.", stopReason: "end_turn" },
      { text: "One worker was cancelled at the budget; four results are below.", stopReason: "end_turn" },
    ])
    const { session } = recordingSession()
    const sent: string[] = []
    const ctx = makeCtx(agentDir, [], sent)
    ctx.task = tasks.start(ctx.sessionId, "parent", () => new Promise(() => {}))
    ctx.agentConfig = { ...AGENT_CONFIG_DEFAULTS, tools: { ...AGENT_CONFIG_DEFAULTS.tools, delegate: { ...AGENT_CONFIG_DEFAULTS.tools.delegate, timeoutMs: 80 } } }
    const child = tasks.start(ctx.sessionId, "worker: agent E", () => new Promise(() => {}), { internal: true, parentTaskId: ctx.task.id })

    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools: [], tasks,
    }).run(ctx)

    expect(calls).toHaveLength(2)
    expect(child.controller.signal.aborted).toBe(true)
    expect(child.status).toBe("cancelled")
    const note = (calls[1]!.history.at(-1)!.data as { text: string }).text
    expect(note).toContain("Cancelled at the budget: worker: agent E")
    expect(sent).toEqual(["One worker was cancelled at the budget; four results are below."])
  })

  test("inside a worker a write call is refused per call, even on an allowed per-call tool", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "delegate-loop-"))
    const seen: unknown[] = []
    const file: Tool = {
      name: "file", description: "rw", schema: z.object({ action: z.string(), path: z.string() }),
      effectOf: (p) => ((p as { action: string }).action === "read" ? "read" : "write"),
      execute: async (p) => { seen.push(p); return { ok: true } },
    }
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "file", params: { action: "write", path: "x" } }, { name: "file", params: { action: "read", path: "x" } }], stopReason: "tool_use" },
    ])
    const { session, events } = recordingSession()
    const ctx = makeCtx(agentDir, [file], [])
    ctx.worker = true
    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools: [file],
    }).run(ctx)
    expect(seen).toEqual([{ action: "read", path: "x" }])
    const results = events.filter(e => e.type === "tool_result").map(e => e.data as { result: { error?: string }; blocked?: boolean })
    expect(results[0]!.blocked).toBe(true)
    expect(results[0]!.result.error).toMatch(/^Workers are read-only/)
    expect(results[1]!.blocked).toBeUndefined()
  })

  test("without running workers the turn ends as usual, and a worker context never waits", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "delegate-loop-"))
    const tasks = new TaskManager(new TaskGateway())
    const { llm, calls } = scriptedLlm([{ text: "done", stopReason: "end_turn" }])
    const { session } = recordingSession()
    const sent: string[] = []
    const ctx = makeCtx(agentDir, [], sent)
    ctx.task = tasks.start(ctx.sessionId, "parent", () => new Promise(() => {}))
    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools: [], tasks,
    }).run(ctx)
    expect(calls).toHaveLength(1)
    expect(sent).toEqual(["done"])
  })
})

describe("LoopService with on-demand skills (CLEAN-150 US2)", () => {
  const ranch = { name: "ranch", description: "Operate the ranch API", path: "/x", content: "# Ranch\n\nCall GET /agents first.", source: "agent" as const }
  const skills = {
    get: (name: string) => (name === "ranch" ? ranch : undefined),
    markLoaded: (_s: string, name: string) => ({ name, chars: ranch.content.length, retainedForTurns: 3 }),
  }
  const skillLoadTool: Tool = {
    name: "skill_load", description: "load", effect: "read", schema: z.object({ name: z.string() }),
    execute: async (params, ctx) => ctx.skills!.markLoaded(ctx.sessionId, (params as { name: string }).name, ctx.turn ?? 0),
  }

  test("a successful skill_load puts the skill body into history ahead of the conversation and leaves the system prompt untouched", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "skill-loop-"))
    const tools = [skillLoadTool]
    const { llm, calls } = scriptedLlm([
      { text: "", toolCalls: [{ name: "skill_load", params: { name: "ranch" } }], stopReason: "tool_use" },
    ])
    const { session } = recordingSession()
    const sent: string[] = []
    const loads: unknown[] = []
    const ctx = makeCtx(agentDir, tools, sent)
    ctx.systemPrompt = "SYSTEM"
    ctx.history = [{ id: "u1", type: "user", ts: 1, data: { text: "how many agents are stale?", from: "u" } }]
    ctx.onDemandLoad = (l) => loads.push(l)

    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools, skills: skills as never,
    }).run(ctx)

    expect(ctx.systemPrompt).toBe("SYSTEM")
    const secondCall = calls[1]!.history
    expect(secondCall[0]!.type).toBe("summary")
    expect((secondCall[0]!.data as { skill: string; text: string }).skill).toBe("ranch")
    expect((secondCall[0]!.data as { text: string }).text).toContain("Call GET /agents first.")
    expect(secondCall[1]!.type).toBe("user")
    expect(loads).toEqual([{ kind: "skill", name: "ranch", chars: ranch.content.length }])
  })
})
