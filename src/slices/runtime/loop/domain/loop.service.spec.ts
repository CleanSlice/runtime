import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { z } from "zod"
import { LoopService } from "./loop.service"
import type { ILoopContext } from "./loop.types"
import type { Event } from "../../../setup/event"
import type { Tool } from "../../../agent/tool"
import type { ModelResponse } from "../../../setup/llm/domain/llm.types"
import { GuardModule } from "../../../agent/guard"
import { VerificationService } from "./verification.service"
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
  execute: async (params) => { seen.push(params); return { stdout: "sk-ant-oat01-abcdefghijklmnop\n" } },
})

async function guardFor(agentDir: string) {
  const guard = new GuardModule(agentDir, { ...AGENT_CONFIG_DEFAULTS.guard, observerTimeoutMs: 200 })
  await guard.load()
  return guard
}

function makeLoop(deps: { llm: unknown; session: unknown; guard?: GuardModule; tools: Tool[] }) {
  return new LoopService({
    llm: deps.llm as never,
    session: deps.session as never,
    activity: { updateStep: () => {}, set: () => {}, clear: () => {} } as never,
    usage: { add: () => {} } as never,
    voice: {} as never,
    channel: {} as never,
    tools: deps.tools,
    guard: deps.guard,
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

describe("LoopService with guardrails (CLEAN-150 US1)", () => {
  test("a blocked call never reaches the tool, carries the reason, and is recorded", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "guard-loop-"))
    const seen: unknown[] = []
    const tools = [execTool(seen)]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "exec", params: { command: "cat data/secrets/key" } }], stopReason: "tool_use" },
    ])
    const { session, events } = recordingSession()
    const guard = await guardFor(agentDir)
    const sent: string[] = []

    await makeLoop({ llm, session, guard, tools }).run(makeCtx(agentDir, tools, sent))

    expect(seen).toEqual([])
    const result = events.find(e => e.type === "tool_result")!
    const data = result.data as { result: { error: string }; blocked?: boolean }
    expect(data.blocked).toBe(true)
    expect(data.result.error).toMatch(/^blocked by rule no-secret-store-reads: /)

    const recordFile = join(agentDir, "data", "toolcalls.jsonl")
    expect(existsSync(recordFile)).toBe(true)
    const line = JSON.parse(readFileSync(recordFile, "utf8").trim().split("\n").pop()!)
    expect(line.tool).toBe("exec")
    expect(line.outcome).toBe("blocked")
    expect(line.rulesFired).toEqual(["no-secret-store-reads", "record-all"])
    expect(line.effect).toBe("write")
  })

  test("a credential in a tool result is redacted for the model and in the persisted transcript", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "guard-loop-"))
    const seen: unknown[] = []
    const tools = [execTool(seen)]
    const { llm, calls } = scriptedLlm([
      { text: "", toolCalls: [{ name: "exec", params: { command: "echo key" } }], stopReason: "tool_use" },
    ])
    const { session, events } = recordingSession()
    const guard = await guardFor(agentDir)
    const sent: string[] = []

    await makeLoop({ llm, session, guard, tools }).run(makeCtx(agentDir, tools, sent))

    expect(seen).toHaveLength(1)
    const modelSaw = JSON.stringify(calls[1]!.history)
    expect(modelSaw).not.toContain("abcdefghijklmnop")
    expect(modelSaw).toContain("sk-ant")
    const stored = events.find(e => e.type === "tool_result")!.data as { result: unknown; redacted?: boolean }
    expect(JSON.stringify(stored.result)).not.toContain("abcdefghijklmnop")
    expect(stored.redacted).toBe(true)
  })

  test("a credential the model typed into tool params is masked in the persisted tool_call", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "guard-loop-"))
    const seen: unknown[] = []
    const tools = [execTool(seen)]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "exec", params: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x.test" } }], stopReason: "tool_use" },
    ])
    const { session, events } = recordingSession()
    const guard = await guardFor(agentDir)

    await makeLoop({ llm, session, guard, tools }).run(makeCtx(agentDir, tools, []))

    // The tool itself still gets the real params — only the record is masked.
    expect(JSON.stringify(seen[0])).toContain("abcdefghijklmnopqrstuvwxyz")
    const stored = events.find(e => e.type === "tool_call")!.data as { params: unknown }
    expect(JSON.stringify(stored.params)).not.toContain("abcdefghijklmnopqrstuvwxyz")
  })

  test("without a guard the loop behaves as before", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "guard-loop-"))
    const seen: unknown[] = []
    const tools = [execTool(seen)]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "exec", params: { command: "cat data/secrets/key" } }], stopReason: "tool_use" },
    ])
    const { session } = recordingSession()
    const sent: string[] = []

    await makeLoop({ llm, session, tools }).run(makeCtx(agentDir, tools, sent))

    expect(seen).toHaveLength(1)
    expect(sent).toEqual(["done"])
  })
})

describe("LoopService with verified completion (CLEAN-150 US5)", () => {
  function verifier(answer: string) {
    const calls: string[] = []
    const service = new VerificationService({ auxComplete: async (system) => { calls.push(system); return { text: answer } } }, { enabled: true, timeoutMs: 1000 })
    return { calls, service }
  }
  const failingHttp: Tool = {
    name: "http", description: "call", effect: "write", schema: z.object({ url: z.string() }),
    execute: async () => ({ error: "500 Internal Server Error" }),
  }
  const readOnly: Tool = {
    name: "web_fetch", description: "fetch", effect: "read", schema: z.object({ url: z.string() }),
    execute: async () => ({ text: "hello" }),
  }

  test("a 'done' after a failed mutating tool is rewritten before delivery", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "verify-loop-"))
    const tools = [failingHttp]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "http", params: { url: "https://api.test/agents/1" } }], stopReason: "tool_use" },
      { text: "Done — the agent name is updated.", stopReason: "end_turn" },
    ])
    const { session, events } = recordingSession()
    const sent: string[] = []
    const { calls, service } = verifier('{"ok":false,"reply":"The update failed: the API returned 500 Internal Server Error."}')

    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools, verification: service,
    }).run(makeCtx(agentDir, tools, sent))

    expect(calls).toHaveLength(1)
    expect(sent).toEqual(["The update failed: the API returned 500 Internal Server Error."])
    const assistant = events.find(e => e.type === "assistant")!.data as { text: string }
    expect(assistant.text).toContain("500")
  })

  test("a read-only turn never calls the verifier", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "verify-loop-"))
    const tools = [readOnly]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "web_fetch", params: { url: "https://x.test" } }], stopReason: "tool_use" },
      { text: "It says hello.", stopReason: "end_turn" },
    ])
    const { session } = recordingSession()
    const sent: string[] = []
    const { calls, service } = verifier('{"ok":false,"reply":"should not be used"}')

    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools, verification: service,
    }).run(makeCtx(agentDir, tools, sent))

    expect(calls).toHaveLength(0)
    expect(sent).toEqual(["It says hello."])
  })

  test("a verifier timeout delivers the draft marked unverified", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "verify-loop-"))
    const tools = [failingHttp]
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [{ name: "http", params: { url: "https://api.test/agents/1" } }], stopReason: "tool_use" },
      { text: "Done.", stopReason: "end_turn" },
    ])
    const { session } = recordingSession()
    const sent: string[] = []
    const slow = new VerificationService({ auxComplete: () => new Promise(res => setTimeout(() => res({ text: '{"ok":true}' }), 300)) }, { enabled: true, timeoutMs: 20 })

    await new LoopService({
      llm: llm as never, session: session as never, activity: { updateStep: () => {} } as never, usage: { add: () => {} } as never,
      voice: {} as never, channel: {} as never, tools, verification: slow,
    }).run(makeCtx(agentDir, tools, sent))

    expect(sent).toEqual(["Done. (unverified)"])
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
