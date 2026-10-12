import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  tasks: z.array(z.object({
    goal: z.string().min(1).describe("What the worker must accomplish, stated so it can be done without the conversation"),
    context: z.string().optional().describe("Facts the worker needs (ids, URLs, constraints) — it starts with an empty history"),
    timeoutMs: z.number().int().positive().optional().describe("Time budget for this worker; defaults to tools.delegate.timeoutMs"),
  })).min(1).max(10),
})

/**
 * Delegation with a completion contract (CLEAN-150 US6). Workers run in
 * isolated contexts with a restricted toolset; independent sub-tasks run
 * concurrently; this call resolves only when every worker has finished or
 * run out of budget, so the parent's reply can carry all of their results.
 */
export const DelegateTaskTool: Tool = {
  name: "delegate_task",
  effect: "write",
  adminOnly: true,
  description:
    `Run one or more sub-tasks in fresh, isolated contexts and get one summary per sub-task back. ` +
    `Use it only when the work does not fit in this conversation — several independent lookups, or a long job whose details would drown the thread. ` +
    `Workers cannot message the person, write memory, change skills or secrets, or delegate further; you own collecting their results and reporting them. ` +
    `Give each goal everything it needs in "context": the worker starts with an empty history.`,
  schema,
  stepLabel(params: unknown): string | undefined {
    const p = schema.safeParse(params)
    return p.success ? `Delegate ${p.data.tasks.length} sub-task${p.data.tasks.length === 1 ? "" : "s"}` : undefined
  },
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { tasks } = schema.parse(params)
    if (!ctx.delegate) return { error: "delegation is not available here (workers cannot delegate further)" }
    const results = await ctx.delegate(tasks)
    return {
      results,
      note: results.some(r => r.status !== "done")
        ? "Some workers did not finish; report their status honestly rather than assuming the work happened."
        : "All workers finished. Summarise their results for the person.",
    }
  },
}
