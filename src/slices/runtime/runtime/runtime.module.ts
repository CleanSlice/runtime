import type { Tool } from "../../agent/tool"
import { buildMessage, MessageRoleTypes, type Message, type ChannelConfig } from "../../setup/channel"
import type { LlmConfig } from "../../setup/llm/llm.module"
import { S3SyncService, type S3SyncConfig } from "../../bot/sync/s3-sync.service"
import { ChannelModule } from "../../setup/channel/channel.module"
import { SessionModule } from "../../agent/session/session.module"
import { AgentModule } from "../../agent/agent/agent.module"
import { isEmptyMessage, EMPTY_MESSAGE_RESPONSE } from "../../agent/agent/domain/agent.service"
import { MemoryModule } from "../../agent/memory/memory.module"
import { CronModule } from "../../agent/cron/cron.module"
import { HeartbeatModule } from "../../agent/heartbeat/heartbeat.module"
import { AccessModule } from "../../bot/access/access.module"
import { LlmModule } from "../../setup/llm/llm.module"
import { SkillModule } from "../../agent/skill/skill.module"
import { VoiceModule } from "../../bot/voice/voice.module"
import { UsageModule } from "../../bot/usage/usage.module"
import { TaskModule } from "../../agent/task/task.module"
import { RouterModule } from "../../agent/router/router.module"
import { randomUUID } from "crypto"
import { InitModule, type IAgentConfig } from "../init"
import { SecretModule } from "../../setup/secret/secret.module"
import { ActivityModule } from "../../bot/activity/activity.module"
import { CommandService } from "../../bot/command/domain/command.service"
import { LoopModule } from "../loop/loop.module"
import { BotService } from "../../bot/bot/domain/bot.service"
import { RuntimeService } from "./domain/runtime.service"
import { createLogger } from "../../setup/logger"

const s3Log = createLogger("s3")
const msgLog = createLogger("msg")

/** External config passed by the entrypoint (index.ts / multi.ts) */
export interface RuntimeConfig {
  init: InitModule
  llm: LlmConfig
  /**
   * Optional auxiliary LLM for background work (compaction, summarization).
   * When omitted, aux calls fall back to the main LLM. Routing aux work to a
   * cheaper/smaller model keeps the main session's prompt cache hot.
   */
  llmAuxiliary?: LlmConfig
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
  private init: InitModule
  private loop: LoopModule

  /**
   * Dependency injection — instantiates and wires all modules.
   * No I/O happens here; everything is lazy until start().
   */
  constructor(config: RuntimeConfig) {
    this.init = config.init
    this.config = config.init.config
    this.channelConfigs = config.channels
    const agentDir = config.init.agentDir
    const tools = config.tools ?? []

    // ── Setup slices (independent infrastructure) ──────────────────

    // LLM provider — inject maxTokens from agent config for Claude
    const llmConfig = config.llm.provider === "claude"
      ? { ...config.llm, maxTokens: this.config.maxTokens }
      : config.llm
    const auxConfig = config.llmAuxiliary
      ? (config.llmAuxiliary.provider === "claude"
        ? { ...config.llmAuxiliary, maxTokens: this.config.maxTokens }
        : config.llmAuxiliary)
      : undefined
    this.llm = new LlmModule(llmConfig, auxConfig)

    // Message transport (Telegram, Slack, etc.) — agentDir enables the
    // file-backed mutation path (channel_* tools, channels.json persistence).
    this.channel = new ChannelModule(config.channels, agentDir)

    // Conversation history with automatic compaction
    this.session = new SessionModule(agentDir, {
      compactionThreshold: this.config.session.compactionThreshold,
      recentKeep: this.config.session.recentKeep,
      compactionBytesThreshold: this.config.session.compactionBytesThreshold,
    })

    // Encrypted credential storage (file-based or AWS Secrets Manager)
    const secrets = new SecretModule(agentDir)

    // ── Agent slices (core capabilities) ───────────────────────────

    // System prompt builder (SOUL.md, USER.md, MEMORY.md, etc.)
    const agent = new AgentModule(agentDir)

    // Long-term memory with search, daily flush, and background review
    this.memory = new MemoryModule(agentDir, this.config.memory.limits, this.config.memory.review)

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

    // Background task manager (start, cancel, inject)
    const taskModule = new TaskModule()
    const tasks = taskModule.manager

    // LLM-backed router — classifies incoming messages as new / join / ambiguous
    const routerModule = new RouterModule(this.llm)
    const router = routerModule.service

    // Crash recovery — detects interrupted tasks on restart
    this.activityModule = new ActivityModule(agentDir)
    const activityService = this.activityModule.service

    // ── Bot slices (user-facing features) ──────────────────────────

    // User access control (open / public / allowlist / code / approval)
    const adminIds = [...new Set([...(process.env.TELEGRAM_BOT_ADMIN_IDS ?? "").split(",").filter(Boolean), ...(process.env.BRIDLE_URL ? ["admin"] : [])])]
    this.access = AccessModule.create(agentDir, adminIds, this.config)
    const access = this.access

    // Slash command handler (/help, /tasks, /cancel, /voice, etc.)
    const commands = new CommandService({ access, skills: this.skills, voice, tasks, session: this.session, memory: this.memory, llm: this.llm })

    // ── Runtime slices (orchestration) ─────────────────────────────

    // LLM ↔ tools execution loop
    this.loop = new LoopModule(
      { llm: this.llm, session: this.session, activity: activityService, usage: this.usage, voice, channel: this.channel, tools },
      { maxIterations: this.config.maxIterations },
    )

    // Message intake router — access check → commands → dispatch
    this.router = new BotService({
      access, commands, tasks, router,
      session: this.session, channel: this.channel,
      stopPhrases: new Set(this.config.stopPhrases.map(p => p.toLowerCase())),
    })

    // Task lifecycle orchestrator — builds prompt, runs loop, cleans up
    this.runtimeService = new RuntimeService({
      session: this.session, agent, skills: this.skills, secrets,
      memory: this.memory, channel: this.channel, activity: activityService,
      llm: this.llm, loop: this.loop, tasks, tools, access,
      agentDir, config: this.config,
    })

    // ── Optional: S3 backup ────────────────────────────────────────

    const debounceMs = this.config.s3?.watcherDebounceMs
    if (config.s3) {
      this.s3sync = new S3SyncService({ ...config.s3, watcherDebounceMs: debounceMs }, agentDir)
    } else if (process.env.S3_BUCKET) {
      this.s3sync = new S3SyncService({ bucket: process.env.S3_BUCKET, prefix: process.env.S3_PREFIX, watcherDebounceMs: debounceMs }, agentDir)
    }

    // Allow the bridle hub to trigger an on-demand push of agent files to S3
    // (e.g. admin clicks "Sync" in the file editor and wants to see fresh state).
    if (this.s3sync) {
      const s3sync = this.s3sync
      this.channel.onBridleSync(async () => ({ pushed: await s3sync.push() }))
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
    // Promote pending self-improvement reviews into MEMORY.md before the
    // final S3 push, so short sessions are not lost on shutdown.
    await this.memory.flushAllPendingReviews(this.llm, this.session)
    if (this.s3sync) {
      this.s3sync.stopWatcher()
      this.s3sync.stopAutoSync()
      try {
        await this.s3sync.push()
      } catch (err) {
        // S3 may be temporarily unreachable on shutdown — don't block exit.
        s3Log.warn(`final push on shutdown failed: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Central message handler — every message flows through here:
   * user messages, cron jobs, heartbeats, and passthroughs.
   *
   * Flow: validate → route (bot) → execute (runtime service)
   */
  async handleMessage(msg: Message): Promise<void> {
    if (isEmptyMessage(msg.text ?? "")) {
      if (msg.channel !== "internal") await this.channel.send(msg.channel, msg.from, EMPTY_MESSAGE_RESPONSE)
      return
    }

    const isInternal = msg.channel === "internal" || msg.from === "cron" || msg.from === "heartbeat"
    if (!isInternal) msgLog.info(`from=${msg.from} ch=${msg.channel} "${msg.text.slice(0, 60)}"`)

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

  /**
   * Pull persisted state from S3 before loading anything.
   *
   * S3 reachability is best-effort: if the bucket / endpoint is misconfigured
   * or temporarily down, we log a warning and start the agent anyway with
   * whatever is on disk (init.gateway already seeded `.agent/` from
   * `.agent.example` on first run, so the agent has a coherent local state).
   * Once S3 comes back, the watcher will push subsequent changes.
   */
  private async restoreState(): Promise<void> {
    if (!this.s3sync) return
    try {
      await this.s3sync.pull()
    } catch (err) {
      s3Log.warn(
        `pull failed on startup — continuing with local state. ` +
        `Subsequent changes will be pushed when S3 is reachable. Error: ${(err as Error).message}`,
      )
    }
    // agent.config.json was loaded before the S3 pull (disk was empty /
    // stale — the constructor's scaffold() step copies .agent.example's
    // config as a placeholder on a fresh container), so it may not match the
    // just-pulled real config. reload() merges the fresh values into `this.
    // config` IN PLACE, so slices holding a direct reference to a nested
    // piece of it (MemoryModule → memory.limits / memory.review, and any
    // live read of `this.config.*` — taskLabelLength, tools.*, s3.syncIntervalSec)
    // pick up the restored values automatically. Slices that instead captured
    // a plain value (not an object reference) at construction need an
    // explicit refresh — heartbeat's intervalMs, session's compaction
    // thresholds, the loop's maxIterations, and the router's stop-phrase set.
    this.init.reload()
    this.heartbeat.setIntervalMs(this.config.heartbeat.intervalMin * 60_000)
    this.session.updateCompactionConfig(this.config.session)
    this.loop.updateMaxIterations(this.config.maxIterations)
    this.router.updateStopPhrases(new Set(this.config.stopPhrases.map(p => p.toLowerCase())))

    // AccessModule was constructed before the S3 pull (disk was empty / stale),
    // so its in-memory strategy may not match the just-pulled access.json.
    this.access.reload()
    // Initial sweep: push any local files that aren't in S3 yet (e.g. freshly
    // scaffolded SOUL.md / skills / agent.config.json on first run). The diff
    // manifest populated by pull() ensures we don't re-upload what we just pulled.
    try {
      await this.s3sync.push()
    } catch (err) {
      s3Log.warn(`initial push failed — watcher will retry on changes. Error: ${(err as Error).message}`)
    }
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
    // Live chat-index signals: every persisted user/assistant turn is reported
    // to the hub over the agent socket (no-op when bridle isn't connected).
    this.session.setActivityReporter({
      report: activity => this.channel.reportSessionActivity(activity),
    })
    // Channel configs were resolved before restoreState() pulled S3 state —
    // on a fresh container fs the per-channel files weren't on disk yet, so
    // file-configured channels (chat-configured Telegram) resolved to nothing
    // and stayed dead after every restart. Reconcile against the pulled state
    // before starting; a reconcile failure degrades to the pre-pull set.
    try {
      await this.channel.reconcileFromDisk()
    } catch (err) {
      s3Log.warn(`channel reconcile after pull failed — starting with boot-time channel set. Error: ${(err as Error).message}`)
    }
    await this.channel.start()
  }

  /**
   * Detect tasks interrupted by a crash and silently resume them.
   * Injects a system-role message into the runtime pipeline (bypassing
   * the user-facing channel) so the agent can review chat/task state and
   * either continue the work or stay silent if the goal was already met.
   */
  private checkRecovery(): void {
    const recovery = this.activityModule.recovery.check()
    if (!recovery) return

    this.activityModule.recovery.clear()

    const sessionId = this.session.getOrCreate(recovery.channel, recovery.userId).id
    const msg = buildMessage({
      id: randomUUID(),
      text: recovery.instruction,
      from: recovery.userId,
      channel: recovery.channel,
      ts: Date.now(),
      role: MessageRoleTypes.System,
    })
    this.runtimeService.execute(msg, sessionId, true)
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
