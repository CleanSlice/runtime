import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import type { IResourceSnapshot } from "../../../../../setup/llm/domain/resource.types"
import { readSystemResources } from "./resource_status.helpers"

const schema = z.object({})

export const ResourceStatusTool: Tool = {
  name: "resource_status",
  description: `Inspect your current operating resources.

Returns a structured snapshot:
  - llm: provider, model, contextWindow, OAuth/API credentials with cooldown state, whether any credential is available right now and the soonest-available estimate.
  - usage: today's token totals (input/output) and call count across all your LLM calls.
  - system: container RSS memory, memory limit (cgroup-aware), CPU%, CPU quota — works inside Docker (cgroup v1/v2) and on host.
  - lastTurn (when present): wall-clock duration, retry count, rate-limit/overloaded flags of the previous LLM turn.

Call this when:
  - The runtime told you "your previous turn was delayed" (auto-injected hint).
  - You're about to do something expensive and want to know the budget.
  - You want to explain resource pressure to the user instead of silently waiting.

Admin-only — operational state is not shown to non-admin users.`,
  schema,
  adminOnly: true,
  async execute(_params: unknown, ctx: ToolContext): Promise<IResourceSnapshot> {
    const llm = ctx.llm?.getResourceSnapshot() ?? {
      provider: "unknown",
      model: "unknown",
      contextWindow: 0,
      maxOutputTokens: 0,
      credentials: [],
      activeCredential: "unknown",
      anyAvailableNow: true,
      soonestAvailableMs: 0,
    }

    const today = ctx.usage?.getCurrent()
    const usage = {
      todayInputTokens: today?.totalInputTokens ?? 0,
      todayOutputTokens: today?.totalOutputTokens ?? 0,
      todayCallCount: today?.totalCallCount ?? 0,
    }

    const system = await readSystemResources()
    const lastTurn = ctx.lastTurnStats?.get(ctx.sessionId)

    return {
      llm,
      usage,
      system,
      lastTurn,
      capturedAt: Date.now(),
    }
  },
}
