import type { RouteResult } from "./bot.types"
import type { Message } from "../../../setup/channel"
import type { AccessModule } from "../../access/access.module"
import type { CommandService } from "../../command/domain/command.service"
import type { TaskManager } from "../../../agent/task/domain/task.service"
import type { SessionModule } from "../../../agent/session/session.module"
import type { ChannelModule } from "../../../setup/channel/channel.module"
import type { Event } from "../../../setup/event"
import { randomUUID } from "crypto"

interface BotDeps {
  access: AccessModule
  commands: CommandService
  tasks: TaskManager
  session: SessionModule
  channel: ChannelModule
  stopPhrases: Set<string>
}

export class BotService {
  constructor(private deps: BotDeps) {}

  async route(msg: Message, sessionId: string): Promise<RouteResult> {
    const send = (text: string) => this.deps.channel.send(msg.channel, msg.from, text)

    // Auto-approve: if admin sends a message containing a 6-char access code
    if (this.deps.access.isAdmin(msg.from)) {
      const codeMatch = msg.text.trim().match(/\b([A-Z0-9]{6})\b/)
      if (codeMatch) {
        const user = this.deps.access.approve(codeMatch[1])
        if (user) {
          console.log(`[access] admin approved user ${user.userId} with code ${codeMatch[1]}`)
          await this.deps.channel.send(msg.channel, user.userId, `🎉 Access granted! Send me a message.`)
          await send(`✅ User ${user.userId} approved.`)
          return { action: "handled" }
        }
      }
    }

    // Command routing
    const cmdResult = await this.deps.commands.handle(
      { from: msg.from, channel: msg.channel, sessionId, text: msg.text },
      send,
    )
    if (cmdResult.handled) {
      if (cmdResult.passthrough) {
        return { action: "passthrough", text: cmdResult.passthrough }
      }
      return { action: "handled" }
    }

    // Access check
    if (!this.deps.access.isAllowed(msg.from)) {
      const user = this.deps.access.getUser(msg.from) ?? this.deps.access.registerPending(msg.from)
      await send(`🔒 Access denied.\n\nSend this code to the bot owner to get access:\n\n🔑 *${user.accessCode}*`)
      return { action: "handled" }
    }

    // Stop detection: cancel all running tasks
    if (this.isStopCommand(msg.text)) {
      const cancelled = this.deps.tasks.cancelAll(sessionId)
      if (cancelled > 0) {
        await send(`Stopped ${cancelled} task${cancelled > 1 ? "s" : ""}.`)
      }
      return { action: "handled" }
    }

    // Dispatcher: decide what to do with this message
    const decision = this.deps.tasks.dispatch(sessionId, msg.text)

    if (decision.kind === "ask") {
      await send(decision.question)
      return { action: "handled" }
    }

    if (decision.kind === "join") {
      console.log(`[${decision.task.id.slice(0, 6)}] ← join: "${msg.text.slice(0, 40)}"`)
      this.deps.tasks.inject(decision.task.id, msg.text)
      const userEvent: Event = {
        id: randomUUID(),
        type: "user",
        ts: Date.now(),
        data: { text: msg.text, from: msg.from },
      }
      await this.deps.session.append(sessionId, userEvent)
      return { action: "join", taskId: decision.task.id }
    }

    return { action: "new-task" }
  }

  private isStopCommand(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[.!?,;:]+$/, "")
    return this.deps.stopPhrases.has(normalized)
  }
}
