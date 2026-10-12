import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  name: z.string().min(1).describe("Skill name exactly as listed in the Available Skills catalogue"),
})

/**
 * The model pulls a skill into the conversation when a catalogue description
 * fits the task (CLEAN-150 US2). The runtime places the skill body into the
 * history — not into the system prompt, which keeps the cached prefix
 * stable — and keeps it there for `skills.retainTurns` turns.
 */
export const SkillLoadTool: Tool = {
  name: "skill_load",
  effect: "read",
  description: `Load a skill's full instructions for this conversation. Call it when a skill in the "Available Skills" catalogue matches what the person needs — its description says when. The instructions arrive in the conversation and stay for a few turns; call again if you need them later. Returns an error for an unknown or unavailable skill (missing env or binary).`,
  schema,
  stepLabel(params: unknown): string | undefined {
    const p = schema.safeParse(params)
    return p.success ? `Load skill ${p.data.name}` : undefined
  },
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { name } = schema.parse(params)
    if (!ctx.skills) return { error: "skills are not available in this runtime" }
    try {
      const info = ctx.skills.markLoaded(ctx.sessionId, name, ctx.turn ?? 0)
      return { ...info, note: "The skill's instructions are now in the conversation above; follow them." }
    } catch (err) {
      return { error: (err as Error).message }
    }
  },
}
