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

  test("a credential in a tool result reaches the model redacted while the transcript keeps the raw value", async () => {
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
    expect(JSON.stringify(stored.result)).toContain("abcdefghijklmnop")
    expect(stored.redacted).toBe(true)
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
