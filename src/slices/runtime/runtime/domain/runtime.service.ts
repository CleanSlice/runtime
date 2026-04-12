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
import type { IAgentConfig } from "../../init"
import { randomUUID } from "crypto"

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
  toolingPrompt: string
  agentDir: string
  config: IAgentConfig
}

export class RuntimeService {
  constructor(private deps: RuntimeDeps) {}

  /** Start a fire-and-forget task for this message */
  execute(msg: Message, sessionId: string, isInternal: boolean): void {
    const labelLen = this.deps.config.taskLabelLength
    const taskLabel = msg.text.slice(0, labelLen) + (msg.text.length > labelLen ? "…" : "")

    const send = async (text: string) => {
      if (msg.channel !== "internal") {
        await this.deps.channel.send(msg.channel, msg.from, text)
      }
    }

    this.deps.tasks.start(sessionId, taskLabel, async (task: Task) => {
      try {
        const tid = task.id.slice(0, 6)
        console.log(`[${tid}] ← "${taskLabel}"`)

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
        const systemPrompt = await this.buildPrompt(msg, tid)

        await this.deps.loop.service.run({
          task,
          sessionId,
          agentDir: this.deps.agentDir,
          from: msg.from,
          channel: msg.channel,
          isInternal,
          systemPrompt,
          history,
          tools: this.deps.tools,
          send,
          streamSend: (ch, to, streamer) => this.deps.channel.streamSend(ch, to, streamer),
          agentConfig: this.deps.config,
          reloadSkills: () => this.deps.skills.reload().then(() => undefined),
        })

        this.deps.session.touch(sessionId)
        this.deps.activity.clear()
        this.deps.memory.flushAndCompact(sessionId, history, this.deps.llm, this.deps.session, this.deps.config.session.compactionThreshold)

      } catch (err) {
        console.error(`[${task.id.slice(0, 6)}] ✗ unhandled:`, err)
        this.deps.activity.clear()
        try {
          if (!isInternal) await this.deps.channel.send(msg.channel, msg.from, "⚠️ Something went wrong. Please try again.")
        } catch { /* ignore */ }
      }
    })
  }

  private async buildHistory(msg: Message, sessionId: string, taskId: string): Promise<Event[]> {
    // Append user message as shared context
    const userEvent: Event = {
      id: randomUUID(),
      type: "user",
      ts: Date.now(),
      data: { text: msg.text, from: msg.from },
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

    // Truncate very long user messages to avoid slow LLM processing
    const MAX_USER_MSG_CHARS = 4000
    for (const evt of history) {
      if (evt.type === "user") {
        const d = evt.data as Record<string, unknown>
        const text = d.text as string | undefined
        if (text && text.length > MAX_USER_MSG_CHARS) {
          const head = text.slice(0, MAX_USER_MSG_CHARS / 2)
          const tail = text.slice(-500)
          d.text = `${head}\n\n[… ${text.length - MAX_USER_MSG_CHARS + 500} characters truncated — message was very long/repetitive …]\n\n${tail}`
        }
      }
    }

    return history
  }

  private async buildPrompt(msg: Message, tid: string): Promise<string> {
    const secretKeys = await this.deps.secrets.list(msg.from).catch(() => [] as string[])
    const dailyMemory = this.deps.memory.readRecentDaily()

    // Get all loaded skills — pass summaries to system prompt catalog
    const allSkills = this.deps.skills.getAll()
    const skillSummaries = allSkills.map(s => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
    }))

    let systemPrompt = await this.deps.agent.buildPrompt({
      userId: msg.from,
      toolingPrompt: this.deps.toolingPrompt,
      secretKeys,
      dailyMemory,
      skills: skillSummaries,
    })

    // Inject full content for always-on skills
    const injected = new Set<string>()
    for (const skill of allSkills) {
      if (skill.metadata?.always) {
        systemPrompt += `\n\n---\n\n## Skill: ${skill.name}\n\n${skill.content}`
        injected.add(skill.name)
        console.log(`[${tid}] skill(always): ${skill.name}`)
      }
    }

    // Inject full content for message-matched skill (skip if already injected)
    const matched = this.deps.skills.select(msg.text)
    if (matched && !injected.has(matched.name)) {
      systemPrompt += `\n\n---\n\n## Active Skill: ${matched.name}\n\n${matched.content}`
      console.log(`[${tid}] skill: ${matched.name}`)
    }

    return systemPrompt
  }
}
