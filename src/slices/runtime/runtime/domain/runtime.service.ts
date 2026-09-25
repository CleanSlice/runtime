import { getMessageImages, type Message } from "../../../setup/channel"
import type { Event } from "../../../setup/event"
import type { SessionModule } from "../../../agent/session/session.module"
import type { AgentModule } from "../../../agent/agent/agent.module"
import type { SkillModule } from "../../../agent/skill/skill.module"
import type { SecretModule } from "../../../setup/secret/secret.module"
import type { MemoryModule } from "../../../agent/memory/memory.module"
import type { ChannelModule } from "../../../setup/channel/channel.module"
import type { ActivityService } from "../../../bot/activity/domain/activity.service"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { LoopModule } from "../../loop/loop.module"
import type { TaskManager } from "../../../agent/task/domain/task.service"
import type { Task } from "../../../agent/task/domain/task.gateway"
import type { Tool } from "../../../agent/tool"
import { ToolService } from "../../../agent/tool/domain/tool.service"
import type { AccessModule } from "../../../bot/access/access.module"
import type { IAgentConfig } from "../../init"
import { buildResourceHintPrompt } from "../../loop/domain/prompts/resource-hint.prompt"
import { truncateStrings } from "../../../agent/session/domain/compaction.service"
import { capPayload, fitEventsToBudget } from "../../../agent/session/domain/contextBudget"
import { limitForUserEvent, truncateUserText } from "./messageTruncation"
import { randomUUID } from "crypto"
import { createLogger } from "../../../setup/logger"

const log = createLogger("runtime")

interface RuntimeDeps {
  session: SessionModule
  agent: AgentModule
  skills: SkillModule
  secrets: SecretModule
  memory: MemoryModule
  channel: ChannelModule
  activity: ActivityService
  llm: LlmModule
  loop: LoopModule
  tasks: TaskManager
  tools: Tool[]
  access: AccessModule
  agentDir: string
  config: IAgentConfig
}

export class RuntimeService {
  constructor(private deps: RuntimeDeps) {}

  /** Start a fire-and-forget task for this message */
  execute(msg: Message, sessionId: string, isInternal: boolean): void {
    const labelLen = this.deps.config.taskLabelLength
    const taskLabel = msg.text.slice(0, labelLen) + (msg.text.length > labelLen ? "…" : "")
    const isAdmin = isInternal ? true : this.deps.access.isAdmin(msg.from)
    const visibleTools = isAdmin ? this.deps.tools : this.deps.tools.filter(t => !t.adminOnly)

    const send = async (
      text: string,
      parts?: import("../../../setup/channel").MessagePart[],
    ) => {
      if (msg.channel !== "internal") {
        await this.deps.channel.send(msg.channel, msg.from, text, parts)
      }
    }

    // Bridle debug snapshots target the same browser client that sent the
    // user message. Non-bridle channels skip this — the channel module
    // no-ops if the channel isn't bridle anyway, but we avoid the call.
    const sendDebug = msg.channel === "bridle"
      ? (payload: import("../../../setup/channel").IBridleDebugPayload) => {
          this.deps.channel.sendBridleDebug(msg.from, payload)
        }
      : undefined

    this.deps.tasks.start(sessionId, taskLabel, async (task: Task) => {
      try {
        const tid = task.id.slice(0, 6)
        log.child(tid).info(`← "${taskLabel}"`)

        this.deps.activity.set({
          taskId: task.id,
          label: taskLabel,
          userId: msg.from,
          channel: msg.channel,
          text: msg.text,
          startedAt: Date.now(),
          lastStep: "started",
        })

        const history = await this.buildHistory(msg, sessionId, task.id)
        const toolingPrompt = ToolService.buildToolingPromptFrom(visibleTools)
        const systemPrompt = await this.buildPrompt(msg, tid, toolingPrompt, isAdmin, sessionId)

        await this.deps.loop.service.run({
          task,
          sessionId,
          agentDir: this.deps.agentDir,
          from: msg.from,
          ...(msg.user ? { user: msg.user } : {}),
          ...(msg.origin ? { origin: msg.origin } : {}),
          channel: msg.channel,
          isInternal,
          systemPrompt,
          history,
          tools: visibleTools,
          send,
          streamSend: (ch, to, streamer) => this.deps.channel.streamSend(ch, to, streamer),
          sendTyping: !isInternal && msg.channel !== "internal"
            ? () => { void this.deps.channel.sendTyping(msg.channel, msg.from) }
            : undefined,
          // Capability-gated: only clients that advertised `thinking` on the
          // triggering message get live reasoning steps (research D6).
          sendThinking: !isInternal && msg.channel !== "internal" && msg.capabilities?.includes("thinking")
            ? (turnId, step) => { void this.deps.channel.sendThinking(msg.channel, msg.from, turnId, step) }
            : undefined,
          agentConfig: this.deps.config,
          reloadSkills: () => this.deps.skills.reload().then(() => undefined),
          access: this.deps.access,
          isAdmin,
          channels: this.deps.channel,
          sendDebug,
        })

        this.deps.session.touch(sessionId)
        this.deps.activity.clear()
        this.deps.memory.flushAndCompact(sessionId, history, this.deps.llm, this.deps.session, this.deps.config.session.compactionThreshold, this.deps.config.session.compactionBytesThreshold)
        this.deps.memory.reviewMemory(sessionId, this.deps.llm, this.deps.session)

      } catch (err) {
        log.child(task.id.slice(0, 6)).error("unhandled", err)
        this.deps.activity.clear()
        try {
          if (!isInternal) await this.deps.channel.send(msg.channel, msg.from, "⚠️ Something went wrong. Please try again.")
        } catch { /* ignore */ }
      }
    }, { internal: isInternal })
  }

  private buildChannelContext(msg: Message): string | undefined {
    const { channel, metadata } = msg
    if (channel === "internal") return undefined

    if (channel === "telegram") {
      const isGroup = metadata?.isGroup as boolean | undefined
      const username = metadata?.username as string | undefined
      const fromName = metadata?.fromName as string | undefined
      const chatTitle = metadata?.chatTitle as string | undefined

      if (isGroup) {
        const groupDesc = chatTitle ? `"${chatTitle}"` : "a group"
        const sender = fromName ?? (username ? `@${username}` : "someone")
        return `You are responding in a Telegram group chat ${groupDesc}. This message is from ${sender}.`
      }

      const firstName = metadata?.firstName as string | undefined
      const lastName = metadata?.lastName as string | undefined
      const languageCode = metadata?.languageCode as string | undefined
      const isPremium = metadata?.isPremium as boolean | undefined

      const fullName = [firstName, lastName].filter(Boolean).join(" ")
      const who = fullName
        ? `${fullName}${username ? ` (@${username})` : ""}`
        : username ? `@${username}` : "a user"
      const notes: string[] = []
      if (languageCode) notes.push(`their Telegram client language is "${languageCode}"`)
      if (isPremium) notes.push("they have Telegram Premium")
      const suffix = notes.length ? ` Note: ${notes.join("; ")}.` : ""

      // Timezone: the Bot API exposes none, so we ask once and persist it in
      // memory. Current UTC lets the agent convert to the user's local time
      // once it knows their zone.
      const nowUtc = new Date().toISOString().slice(0, 16).replace("T", " ")
      const tzHint =
        ` The current time is ${nowUtc} UTC. If you don't already know this user's timezone` +
        ` (check your Memory / Recent Notes above), ask them once — naturally, when timing is` +
        ` relevant — then save it via memory_save as \`[fact] User timezone: <IANA name>\` and` +
        ` use it for any time- or date-sensitive replies.`
      return `You are responding via Telegram (direct message) with ${who}.${suffix}${tzHint}`
    }

    if (channel === "bridle") return "You are responding via the Bridle web embed."
    if (channel === "slack") return "You are responding via Slack."
    return `You are responding via ${channel}.`
  }

  private async buildHistory(msg: Message, sessionId: string, taskId: string): Promise<Event[]> {
    // Append user message as shared context
    const userEvent: Event = {
      // On bridle the message id is minted by the person's browser and rides
      // the whole way here. Keeping it as the event id makes the bubble on
      // screen and the transcript entry one message, so a reload can tell
      // "already saved" from "never arrived" without guessing by text
      // (CLEAN-102). Other channels' ids are not unique across a session.
      id: msg.channel === "bridle" && msg.id ? msg.id : randomUUID(),
      type: "user",
      ts: Date.now(),
      // Attachment references persist with the turn so transcript replays
      // can re-link the stored files. LLM prompt builders read only
      // data.text / data.images, so the extra key never reaches the model.
      data: {
        text: msg.text,
        from: msg.from,
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      },
    }
    await this.deps.session.append(sessionId, userEvent)

    const history = await this.deps.session.readForTask(sessionId, taskId)

    // Inject images into the last user event (in-memory only)
    const images = getMessageImages(msg)
    if (images.length) {
      const lastUserEvent = history[history.length - 1]
      if (lastUserEvent && lastUserEvent.type === "user") {
        (lastUserEvent.data as Record<string, unknown>).images = images
      }
    }

    // Truncate very long user messages to avoid slow LLM processing. A turn
    // that carried an attachment gets a much larger cap: the API already
    // bounded that preview on its way in, and cutting it again left the model
    // a fragment of sheet one. See messageTruncation.ts.
    //
    // `attachments` is read off the persisted event, not the live Message, so
    // a replayed history keeps the same cap it was written under.
    const messageLimits = this.deps.config.message
    for (const evt of history) {
      if (evt.type === "user") {
        const d = evt.data as Record<string, unknown>
        const text = d.text as string | undefined
        if (!text) continue
        const hasAttachments = Array.isArray(d.attachments) && d.attachments.length > 0
        d.text = truncateUserText(text, limitForUserEvent(hasAttachments, messageLimits))
      }
    }

    // Cap tool_call / tool_result payloads sent to the LLM. Raw API responses
    // (catalogs, page dumps, CDN URLs) can be tens of KB each; a handful of
    // them blows the model's context window even when the event COUNT is well
    // below the compaction threshold. The full payload stays on disk for
    // retrieval — only the in-memory copy handed to the model is trimmed.
    //
    // The cap has to clear a `query_attachment` read: that tool is how the
    // model gets exact cells once the inline preview runs out, so trimming
    // its result puts it back to estimating.
    //
    // Per string first, then in total (CLEAN-124): an MCP catalogue is
    // thousands of short strings that each pass the per-string cap and
    // together do not.
    const maxToolOutputChars = this.deps.config.tools.maxOutputChars
    for (const evt of history) {
      if (evt.type === "tool_call" || evt.type === "tool_result") {
        evt.data = capPayload(truncateStrings(evt.data, maxToolOutputChars), maxToolOutputChars)
      }
    }

    // And the whole history has a ceiling of its own, so one session that
    // compaction could not shrink (it needs the model too, and the model
    // refused the oversized prompt) does not fail every turn from then on.
    const fitted = fitEventsToBudget(history, this.deps.config.session.contextBudgetChars)
    if (fitted.dropped > 0) {
      log.warn(`session ${sessionId}: ${fitted.dropped} events left out to fit ${this.deps.config.session.contextBudgetChars} chars`)
    }
    return fitted.events
  }

  private async buildPrompt(msg: Message, tid: string, toolingPrompt: string, isAdmin: boolean, sessionId: string): Promise<string> {
    const secretKeys = await this.deps.secrets.list().catch(() => [] as string[])
    const dailyMemory = this.deps.memory.readRecentDaily()

    // Get all loaded skills — pass summaries to system prompt catalog
    const allSkills = this.deps.skills.getAll()
    const skillSummaries = allSkills.map(s => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
    }))

    // One-shot resource-status hint: if the previous LLM turn for this
    // session was delayed (retries, rate limit, overload, >30s), nudge the
    // agent to inspect resources. `consume` removes the entry so the hint
    // fires exactly once per delayed turn.
    let extraHint: string | undefined
    const tracker = this.deps.loop.service.lastTurnStats
    if (tracker.wasDelayed(sessionId)) {
      const stats = tracker.consume(sessionId)
      if (stats) {
        extraHint = buildResourceHintPrompt(stats)
        log.child(tid).info(`injecting resource hint (elapsed=${stats.elapsedMs}ms retries=${stats.retries} 429=${stats.rateLimited} overload=${stats.overloaded})`)
      }
    }

    let systemPrompt = await this.deps.agent.buildPrompt({
      userId: msg.from,
      toolingPrompt,
      secretKeys,
      dailyMemory,
      skills: skillSummaries,
      isAdmin,
      extraHint,
      integratorPrompt: msg.prompt,
      channelContext: this.buildChannelContext(msg),
    })

    // Inject full content for always-on skills
    const injected = new Set<string>()
    for (const skill of allSkills) {
      if (skill.metadata?.always) {
        systemPrompt += `\n\n---\n\n## Skill: ${skill.name}\n\n${skill.content}`
        injected.add(skill.name)
        log.child(tid).info(`skill(always): ${skill.name}`)
      }
    }

    // Inject full content for message-matched skill (skip if already injected)
    const matched = this.deps.skills.select(msg.text)
    if (matched && !injected.has(matched.name)) {
      systemPrompt += `\n\n---\n\n## Active Skill: ${matched.name}\n\n${matched.content}`
      log.child(tid).info(`skill: ${matched.name}`)
    }

    return systemPrompt
  }
}
