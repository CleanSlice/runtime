import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { DelegateService } from "./delegate.service"
import type { ILoopContext } from "./loop.types"
import type { Tool } from "../../../agent/tool"
import { TaskManager } from "../../../agent/task/domain/task.service"
import { TaskGateway } from "../../../agent/task/data/task.gateway"
import { AGENT_CONFIG_DEFAULTS } from "../../init/domain/init.types"

const tool = (name: string, effect: "read" | "write" = "read", perCall = false): Tool => ({
  name, description: name, schema: z.object({}), execute: async () => ({}),
  ...(perCall ? { effectOf: () => "read" as const } : { effect }),
})

function parentCtx(tasks: TaskManager, tools: Tool[]): ILoopContext {
  const task = tasks.start("tg:admin", "parent", () => new Promise(() => {}))
  return {
    task,
    sessionId: "tg:admin",
    agentDir: "/agent",
    from: "admin",
    channel: "telegram",
    isInternal: false,
    systemPrompt: "SOUL",
    history: [{ id: "u", type: "user", ts: 1, data: { text: "report on five agents", from: "admin" } }],
    tools,
    send: async () => {},
    streamSend: async () => undefined,
    agentConfig: AGENT_CONFIG_DEFAULTS,
    reloadSkills: async () => {},
    isAdmin: true,
  }
}

describe("DelegateService (CLEAN-150 US6)", () => {
  test("workers get a fresh history, the parent's identity, internal flag, parentTaskId and no blocked tools", async () => {
    const tasks = new TaskManager(new TaskGateway())
    const seen: ILoopContext[] = []
    const loop = { run: async (ctx: ILoopContext) => { seen.push(ctx); return { text: `done: ${(ctx.history[0]!.data as { text: string }).text.includes("GOAL: A") ? "A" : "B"}`, errorLimitHit: false } } }
    const svc = new DelegateService({ tasks, loop, config: { timeoutMs: 5_000, maxParallel: 5, summaryChars: 4000 } })
    const parent = parentCtx(tasks, [
      tool("http", "write", true),      // per-call effect — allowed, the loop refuses its write calls
      tool("telegram_send", "write"),   // named block
      tool("memory_save", "write"),     // named block
      tool("delegate_task", "write"),   // named block
      tool("channel_list", "read"),     // channel_* block even though read
      tool("web_fetch", "read"),        // allowed
      tool("exec", "write"),            // write-effect, not named — excluded by effect
      tool("ranch__delete_agent", "write"), // MCP write tool — excluded by effect
    ])

    const results = await svc.run(parent, [{ goal: "A" }, { goal: "B", context: "use the API" }])

    expect(results.map(r => r.status)).toEqual(["done", "done"])
    expect(results.map(r => r.summary)).toEqual(["done: A", "done: B"])
    for (const ctx of seen) {
      expect(ctx.history).toHaveLength(1)
      expect(ctx.history[0]!.type).toBe("user")
      expect(ctx.systemPrompt).toBe("SOUL")
      expect(ctx.isInternal).toBe(true)
      expect(ctx.worker).toBe(true)
      expect(ctx.channel).toBe("internal")
      expect(ctx.task.internal).toBe(true)
      expect(ctx.task.parentTaskId).toBe(parent.task.id)
      expect(ctx.tools.map(t => t.name).sort()).toEqual(["http", "web_fetch"])
    }
    expect((seen[1]!.history[0]!.data as { text: string }).text).toContain("CONTEXT:\nuse the API")
    expect(tasks.getChildren(parent.task.id)).toHaveLength(2)
  })

  test("allowWrite hands workers the parent's write tools except the named blocks", async () => {
    const tasks = new TaskManager(new TaskGateway())
    const seen: ILoopContext[] = []
    const loop = { run: async (ctx: ILoopContext) => { seen.push(ctx); return { text: "ok", errorLimitHit: false } } }
    const svc = new DelegateService({ tasks, loop, config: { timeoutMs: 5_000, maxParallel: 5, summaryChars: 4000, allowWrite: true } })
    await svc.run(parentCtx(tasks, [tool("exec", "write"), tool("telegram_send", "write"), tool("web_fetch", "read")]), [{ goal: "x" }])
    expect(seen[0]!.tools.map(t => t.name).sort()).toEqual(["exec", "web_fetch"])
  })

  test("independent requests run concurrently, bounded by maxParallel", async () => {
    const tasks = new TaskManager(new TaskGateway())
    let running = 0
    let peak = 0
    const loop = {
      run: async () => {
        running++; peak = Math.max(peak, running)
        await new Promise(r => setTimeout(r, 30))
        running--
        return { text: "ok", errorLimitHit: false }
      },
    }
    const svc = new DelegateService({ tasks, loop, config: { timeoutMs: 5_000, maxParallel: 2, summaryChars: 4000 } })
    const results = await svc.run(parentCtx(tasks, []), [{ goal: "1" }, { goal: "2" }, { goal: "3" }, { goal: "4" }, { goal: "5" }])
    expect(results).toHaveLength(5)
    expect(peak).toBe(2)
  })

  test("a worker over budget is cancelled and reported as timeout with partial output", async () => {
    const tasks = new TaskManager(new TaskGateway())
    const loop = {
      run: async (ctx: ILoopContext) => {
        await ctx.send("half way")
        await new Promise<void>((resolve) => { ctx.task.controller.signal.addEventListener("abort", () => resolve()); setTimeout(resolve, 2_000) })
        return { text: "late", errorLimitHit: false }
      },
    }
    const svc = new DelegateService({ tasks, loop, config: { timeoutMs: 40, maxParallel: 5, summaryChars: 4000 } })
    const parent = parentCtx(tasks, [])
    const [r] = await svc.run(parent, [{ goal: "slow" }])
    expect(r!.status).toBe("timeout")
    expect(r!.summary).toContain("half way")
    expect(tasks.getChildren(parent.task.id)[0]!.controller.signal.aborted).toBe(true)
  })

  test("summaries are cut to summaryChars and a throwing worker is an error, not a crash", async () => {
    const tasks = new TaskManager(new TaskGateway())
    let n = 0
    const loop = { run: async () => { if (n++ === 0) return { text: "x".repeat(500), errorLimitHit: false }; throw new Error("boom") } }
    const svc = new DelegateService({ tasks, loop, config: { timeoutMs: 5_000, maxParallel: 5, summaryChars: 100 } })
    const [a, b] = await svc.run(parentCtx(tasks, []), [{ goal: "long" }, { goal: "bad" }])
    expect(a!.truncated).toBe(true)
    expect(a!.summary.length).toBe(100)
    expect(b!.status).toBe("error")
    expect(b!.summary).toBe("boom")
  })
})
