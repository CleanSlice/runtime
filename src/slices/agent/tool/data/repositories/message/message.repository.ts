import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import type { ChannelServer } from "../../../../../setup/channel/channel.module"

const schema = z.object({
  to: z.string().describe("Recipient ID"),
  text: z.string().describe("Message text"),
  channel: z.string().describe("Channel name (e.g. telegram)"),
})

export function createMessageTool(server: ChannelServer): Tool {
  return {
    name: "message",
    description: "Send a message to a user on a specific channel",
    schema,
    async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
      const { to, text, channel } = schema.parse(params)
      await server.send(channel, to, text)
      return { sent: true }
    },
  }
}
