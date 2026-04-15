import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  code: z.string().describe("The 6-character access code from the user requesting access"),
})

export const ApproveUserTool: Tool = {
  name: "approve_user",
  description: "Approve a pending user by their access code. Only the bot owner (admin) can use this. The user will be notified automatically.",
  schema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { code } = schema.parse(params)
    if (!ctx.access) return { error: "Access module is not available in this context." }

    const user = ctx.access.approve(code.toUpperCase())
    if (!user) return { error: `No pending user found with code "${code}".` }

    return {
      success: true,
      userId: user.userId,
      message: `User ${user.userId} has been approved. They will be able to use the bot on their next message.`,
    }
  },
}
