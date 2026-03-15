import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { AccessModule } from "../../../../access/access.module"
import { InviteRepository } from "../../../../access/data/repositories/invite/invite.repository"

const schema = z.object({
  action: z.enum(["get_link", "stats", "list_users"]).describe(
    "get_link: get your personal invite link | stats: show total/active/pending users | list_users: list all users"
  ),
})

export const InviteTool: Tool = {
  name: "invite",
  description: "Manage invite-based access. Get your referral link, check stats, or list users.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { action } = schema.parse(params)
    const adminIds = (process.env.ADMIN_IDS ?? "").split(",").filter(Boolean)
    const access = new AccessModule(ctx.agentDir, adminIds, new InviteRepository())
    const botUsername = process.env.BOT_USERNAME ?? "dv_cleanslice_bot"

    if (action === "get_link") {
      // Ensure user record exists
      let user = access.getUser(ctx.from ?? "")
      if (!user && ctx.from) {
        user = access.registerPending(ctx.from)
      }
      if (!user) return { error: "No user found" }
      const link = access.getInviteLink(user.userId, botUsername)
      return { link, userId: user.userId, status: user.status }
    }

    if (action === "stats") {
      return access.stats()
    }

    if (action === "list_users") {
      // Only admins can list users
      if (!access.isAdmin(ctx.from ?? "")) {
        return { error: "Admin only" }
      }
      const store = (access as any).store as { users: Record<string, unknown> }
      return Object.values(store.users)
    }

    return { error: "Unknown action" }
  },
}
