import type { Tool } from "../../agent/tool"
import { buildMessage, MessageRoleTypes, type Message, type ChannelConfig } from "../../setup/channel"
import type { LlmConfig } from "../../setup/llm/llm.module"
import { S3SyncService, type S3SyncConfig } from "../../bot/sync/s3-sync.service"
import { ChannelModule } from "../../setup/channel/channel.module"
import { SessionModule } from "../../agent/session/session.module"
import { AgentModule } from "../../agent/agent/agent.module"
import { MemoryModule } from "../../agent/memory/memory.module"
import { CronModule } from "../../agent/cron/cron.module"
import { HeartbeatModule } from "../../agent/heartbeat/heartbeat.module"
import { AccessModule } from "../../bot/access/access.module"
import { LlmModule } from "../../setup/llm/llm.module"
import { SkillModule } from "../../agent/skill/skill.module"
import { VoiceModule } from "../../bot/voice/voice.module"
import { UsageModule } from "../../bot/usage/usage.module"
import { TaskModule } from "../../agent/task/task.module"
import { randomUUID } from "crypto"
import { InitModule, type IAgentConfig } from "../init"
import { SecretModule } from "../../setup/secret/secret.module"
import { ActivityModule } from "../../bot/activity/activity.module"
import { CommandService } from "../../bot/command/domain/command.service"
import { LoopModule } from "../loop/loop.module"
import { BotService } from "../../bot/bot/domain/bot.service"
import { RuntimeService } from "./domain/runtime.service"

/** External config passed by the entrypoint (index.ts / multi.ts) */
export interface RuntimeConfig {
  init: InitModule
  llm: LlmConfig
  channels: ChannelConfig[]
  tools?: Tool[]
  s3?: S3SyncConfig
}

/**
 * Top-level orchestrator. Wires all slice modules together,
 * manages the application lifecycle (start/stop), and routes
 * every incoming message through bot → runtime pipeline.
 */
export class AgentRuntime {
  private config: IAgentConfig
  private llm: LlmModule
  private channel: ChannelModule
  private session: SessionModule
  private memory: MemoryModule
  private cron: CronModule
  private heartbeat: HeartbeatModule
  private skills: SkillModule
  private usage: UsageModule
  private router: BotService
  private runtimeService: RuntimeService
  private activityModule: ActivityModule
  private channelConfigs: RuntimeConfig["channels"]
  private s3sync?: S3SyncService
  private access: AccessModule

  /**
   * Dependency injection — instantiates and wires all modules.
   * No I/O happens here; everything is lazy until start().
   */
  constructor(config: RuntimeConfig) {
    this.config = config.init.config
    this.channelConfigs = config.channels
    const agentDir = config.init.agentDir
    const tools = config.tools ?? []

    // ── Setup slices (independent infrastructure) ──────────────────

    // LLM provider — inject maxTokens from agent config for Claude
    const llmConfig = config.llm.provider === "claude"
      ? { ...config.llm, maxTokens: this.config.maxTokens }
      : config.llm
    this.llm = new LlmModule(llmConfig)

    // Message transport (Telegram, Slack, etc.)
    this.channel = new ChannelModule(config.channels)

    // Conversation history with automatic compaction
    this.session = new SessionModule(agentDir, {
      compactionThreshold: this.config.session.compactionThreshold,
      recentKeep: this.config.session.recentKeep,
    })

    // Encrypted credential storage (file-based or AWS Secrets Manager)
    const secrets = new SecretModule(agentDir)

    // ── Agent slices (core capabilities) ───────────────────────────

    // System prompt builder (SOUL.md, USER.md, MEMORY.md, etc.)
    const agent = new AgentModule(agentDir)

    // Long-term memory with search and daily flush
    this.memory = new MemoryModule(agentDir)

    // Scheduled jobs (user-defined via cron tool)
    this.cron = new CronModule(agentDir)

    // Periodic heartbeat that triggers self-initiated messages
    this.heartbeat = new HeartbeatModule(agentDir, this.config.heartbeat.intervalMin * 60 * 1000)

    // Dynamically loaded skills (markdown files in .agent/skills/)
    this.skills = new SkillModule(agentDir)

    // Per-user voice/TTS toggle
    const voice = new VoiceModule(agentDir)

    // Daily token usage tracking and reporting
    this.usage = new UsageModule(agentDir)

    // Background task manager (start, cancel, dispatch)
    const taskModule = new TaskModule()
    const tasks = taskModule.manager

    // Crash recovery — detects interrupted tasks on restart
    this.activityModule = new ActivityModule(agentDir)
    const activityService = this.activityModule.service

    // ── Bot slices (user-facing features) ──────────────────────────

    // User access control (open / public / allowlist / code / approval)
    const adminIds = [...new Set([...(process.env.TELEGRAM_BOT_ADMIN_IDS ?? "").split(",").filter(Boolean), ...(process.env.BRIDLE_URL ? ["admin"] : [])])]
    this.access = AccessModule.create(agentDir, adminIds, this.config)
    const access = this.access

    // Slash command handler (/help, /tasks, /cancel, /voice, etc.)
    const commands = new CommandService({ access, skills: this.skills, voice, tasks, session: this.session })

    // ── Runtime slices (orchestration) ─────────────────────────────

    // LLM ↔ tools execution loop
    const loop = new LoopModule(
      { llm: this.llm, session: this.session, activity: activityService, usage: this.usage, voice, tools },
      { maxIterations: this.config.maxIterations },
    )

    // Message intake router — access check → commands → dispatch
    this.router = new BotService({
      access, commands, tasks,
      session: this.session, channel: this.channel,
      stopPhrases: new Set(this.config.stopPhrases.map(p => p.toLowerCase())),
    })

    // Task lifecycle orchestrator — builds prompt, runs loop, cleans up
    this.runtimeService = new RuntimeService({
      session: this.session, agent, skills: this.skills, secrets,
      memory: this.memory, channel: this.channel, activity: activityService,
      llm: this.llm, loop, tasks, tools, access,
      agentDir, config: this.config,
    })

    // ── Optional: S3 backup ────────────────────────────────────────

    const debounceMs = this.config.s3?.watcherDebounceMs
    if (config.s3) {
      this.s3sync = new S3SyncService({ ...config.s3, watcherDebounceMs: debounceMs }, agentDir)
    } else if (process.env.S3_BUCKET) {
      this.s3sync = new S3SyncService({ bucket: process.env.S3_BUCKET, prefix: process.env.S3_PREFIX, watcherDebounceMs: debounceMs }, agentDir)
    }
  }

  /** Boot the agent: restore state, connect channels, start background jobs. */
  async start(): Promise<void> {
    await this.restoreState()
    await this.loadState()
    await this.connectChannels()
    this.checkRecovery()
    this.startBackgroundJobs()
  }

  /** Graceful shutdown: disconnect channels, flush state, push to S3. */
  async stop(): Promise<void> {
    await this.channel.stop()
    this.cron.stop()
    this.heartbeat.stop()
    await this.usage.flush()
    if (this.s3sync) {
      this.s3sync.stopWatcher()
      this.s3sync.stopAutoSync()
      await this.s3sync.push()
    }
  }

  /**
   * Central message handler — every message flows through here:
   * user messages, cron jobs, heartbeats, and passthroughs.
   *
   * Flow: validate → route (bot) → execute (runtime service)
   */
  async handleMessage(msg: Message): Promise<void> {
    if (!msg.text?.trim()) {
      if (msg.channel !== "internal") await this.channel.send(msg.channel, msg.from, "What can I help you with?")
      return
    }

    const isInternal = msg.channel === "internal" || msg.from === "cron" || msg.from === "heartbeat"
    if (!isInternal) console.log(`[msg] from=${msg.from} ch=${msg.channel} "${msg.text.slice(0, 60)}"`)

    const sessionId = this.session.getOrCreate(msg.channel, msg.from).id

    // Bot routing — passthrough loop handles commands like /memory that
    // transform into LLM queries (max 1 passthrough to prevent cycles)
    if (!isInternal) {
      let currentMsg = msg
      const route = await this.router.route(currentMsg, sessionId)
      if (route.action === "passthrough") {
        currentMsg = { ...currentMsg, text: route.text }
      } else if (route.action !== "new-task") {
        return
      }
      msg = currentMsg
    }

    this.runtimeService.execute(msg, sessionId, isInternal)
  }

  // ── Private lifecycle steps ────────────────────────────────────

  /** Pull persisted state from S3 before loading anything. */
  private async restoreState(): Promise<void> {
    if (!this.s3sync) return
    await this.s3sync.pull()
    // AccessModule was constructed before the S3 pull (disk was empty / stale),
    // so its in-memory strategy may not match the just-pulled access.json.
    this.access.reload()
    this.s3sync.startWatcher()
    // Periodic full sweep is opt-in (0 = off); watcher handles changes in real time.
    this.s3sync.startAutoSync(this.config.s3?.syncIntervalSec ?? 0)
  }

  /** Load memory, skills, and start usage tracking. */
  private async loadState(): Promise<void> {
    const adminIds = [...new Set([...(process.env.TELEGRAM_BOT_ADMIN_IDS ?? "").split(",").filter(Boolean), ...(process.env.BRIDLE_URL ? ["admin"] : [])])]
    this.memory.ensureAdminInMemory(adminIds)
    await this.memory.load()
    await this.skills.load()
    this.usage.start()
  }

  /** Connect to messaging channels and start listening. */
  private async connectChannels(): Promise<void> {
    this.channel.onMessage(msg => this.handleMessage(msg))
    await this.channel.start()
  }

  /** Detect tasks interrupted by a crash and notify the user. */
  private checkRecovery(): void {
    const recovery = this.activityModule.recovery.check()
    if (!recovery) return
    this.channel.send(recovery.channel, recovery.userId, recovery.message)
      .then(() => this.activityModule.recovery.clear())
      .catch(err => { console.error("[recovery] failed:", err); this.activityModule.recovery.clear() })
  }

  /** Wire cron and heartbeat — both emit synthetic internal messages. */
  private startBackgroundJobs(): void {
    // Skip background jobs when all channels are mock (e.g. paddock eval runs)
    const allMock = this.channelConfigs.every(c => c.type === "mock")
    if (allMock) return

    this.cron.onJob(async job => {
      await this.handleMessage(buildMessage({
        id: randomUUID(), text: job.message,
        from: job.to ?? "cron", channel: job.channel ?? "internal",
        ts: Date.now(), role: MessageRoleTypes.System,
      }))
    })
    this.cron.start()

    this.heartbeat.onHeartbeat(async (message) => {
      await this.handleMessage(buildMessage({
        id: randomUUID(), text: message,
        from: "heartbeat", channel: "internal",
        ts: Date.now(), role: MessageRoleTypes.System,
      }))
    })
    this.heartbeat.start()
  }
}
