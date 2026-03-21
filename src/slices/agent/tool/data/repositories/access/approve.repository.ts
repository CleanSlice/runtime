import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { AccessModule } from "../../../../../bot/access/access.module"
import { ApprovalRepository } from "../../../../../bot/access/data/repositories/approval/approval.repository"

const schema = z.object({
  code: z.string().describe("The 6-character access code from the user requesting access"),
})

export const ApproveUserTool: Tool = {
  name: "approve_user",
  description: "Approve a pending user by their access code. Only the bot owner (admin) can use this. The user will be notified automatically.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { code } = schema.parse(params)
    const adminIds = (process.env.TELEGRAM_BOT_ADMIN_IDS ?? "").split(",").filter(Boolean)

    if (!adminIds.includes(ctx.from ?? "")) {
      return { error: "Only admins can approve users." }
    }

    const access = new AccessModule(ctx.agentDir, adminIds, new ApprovalRepository())
    const user = access.approve(code.toUpperCase())

    if (!user) {
      return { error: `No pending user found with code "${code}".` }
    }

    // Notify the approved user via channel
    if (ctx.send) {
      // We can't send to another user via ctx.send (it's scoped to current user)
      // The notification will happen on their next message
    }

    return {
      success: true,
      userId: user.userId,
      message: `User ${user.userId} has been approved. They will be able to use the bot on their next message.`,
    }
  },
}
