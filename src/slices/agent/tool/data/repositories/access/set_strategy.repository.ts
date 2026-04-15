import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  strategy: z.enum(["open", "public", "allowlist", "code", "approval"]).describe(
    "Access strategy. " +
    "open=anyone in (no admin gating beyond mutating tools), " +
    "public=anyone in (mutating tools admin-only — recommended for shared bots), " +
    "allowlist=only users in allowlist, " +
    "code=users must send accessCode, " +
    "approval=admin approves each user via 6-char code (default)."
  ),
  allowlist: z.array(z.string()).optional().describe("User IDs for allowlist strategy"),
  accessCode: z.string().optional().describe("Secret code for code strategy"),
})

export const SetAccessStrategyTool: Tool = {
  name: "set_access_strategy",
  description:
    "Switch the bot's access strategy at runtime. The change is persisted to data/access.json " +
    "and survives restarts. Admin-only.",
  schema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { strategy, allowlist, accessCode } = schema.parse(params)
    if (!ctx.access) return { error: "Access module is not available in this context." }

    if (strategy === "allowlist" && (!allowlist || allowlist.length === 0)) {
      return { error: "allowlist strategy requires a non-empty allowlist array." }
    }
    if (strategy === "code" && !accessCode) {
      return { error: "code strategy requires accessCode." }
    }

    ctx.access.setStrategy(strategy, { allowlist, accessCode })
    return {
      success: true,
      strategy,
      message: `Access strategy switched to "${strategy}".`,
    }
  },
}
