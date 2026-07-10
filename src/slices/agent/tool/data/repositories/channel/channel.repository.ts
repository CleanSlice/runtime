import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

// Generic channel management tools. Per-channel data lives in
// <agentDir>/data/channels/<type>.json (persisted, S3-synced); changes apply
// immediately — no pod restart needed. Channel-specific tools live in their
// own repository folders (e.g. telegram/ holds channel_telegram_set,
// telegram_send, telegram_groups).
//
// Bridle is intentionally NOT exposed here. It's the bootstrap channel the
// runtime can't reconfigure without losing the very link that delivers tool
// calls. It stays env-only.

export const ChannelRemoveTool: Tool = {
  name: "channel_remove",
  description:
    "Disconnect a configured channel and delete its data/channels/<type>.json file (for telegram this includes the group registry). Use to stop receiving messages on that platform. Bridle cannot be removed this way — it's the bootstrap channel.",
  adminOnly: true,
  schema: z.object({
    type: z.enum(["telegram", "slack"]).describe("Channel type to remove"),
  }),
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { type } =
      (ChannelRemoveTool.schema as ReturnType<typeof z.object>).parse(params) as {
        type: "telegram" | "slack"
      }
    if (!ctx.channels) {
      return { error: "Channel registry not available in this context" }
    }
    try {
      const removed = await ctx.channels.removeChannel(type)
      return removed
        ? { ok: true, removed: type }
        : { ok: false, message: `No ${type} channel was configured.` }
    } catch (err) {
      return { error: `Failed to remove ${type}: ${(err as Error).message}` }
    }
  },
}

export const ChannelListTool: Tool = {
  name: "channel_list",
  description:
    "List currently configured channels with their source (file or env), live connection state, and masked credentials. Bridle, when present, is always env-sourced.",
  schema: z.object({}),
  async execute(_params: unknown, ctx: ToolContext): Promise<unknown> {
    if (!ctx.channels) {
      return { error: "Channel registry not available in this context" }
    }
    return { channels: await ctx.channels.listInfo() }
  },
}

const channelGroupsSchema = z.object({
  channel: z
    .string()
    .optional()
    .describe('Limit to one channel type, e.g. "telegram" or "slack". Omit for all.'),
})

export const ChannelGroupsTool: Tool = {
  name: "channel_groups",
  description:
    "List the groups/rooms the bot works in, per channel: Telegram groups and channels (with chat_id, title, membership status) and Slack channels the bot is a member of. " +
    "Use this to resolve a group name to an id for telegram_send or channel sends. " +
    "Telegram groups appear after the bot is added to them or sees a message there; Slack is queried live.",
  schema: channelGroupsSchema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { channel } = channelGroupsSchema.parse(params)
    if (!ctx.channels) {
      return { error: "Channel registry not available in this context" }
    }
    const results = await ctx.channels.listGroups(channel)
    if (!results.length) {
      return {
        channels: [],
        note: channel
          ? `No running channel of type "${channel}" supports groups.`
          : "No running channels support groups.",
      }
    }
    return {
      channels: results.map(r => ({
        channel: r.channel,
        ...(r.error ? { error: r.error } : {}),
        groups: r.groups.map(g => ({
          id: g.id,
          ...(g.name ? { name: g.name } : {}),
          ...(g.username ? { username: `@${g.username}` } : {}),
          ...(g.type ? { type: g.type } : {}),
          ...(g.status ? { status: g.status } : {}),
          ...(g.lastSeenAt ? { lastSeenAt: new Date(g.lastSeenAt).toISOString() } : {}),
        })),
      })),
    }
  },
}
