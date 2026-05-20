import type { MemoryLimits, MemoryReviewConfig } from "../../../agent/memory/domain/memory.types"
import { DEFAULT_MEMORY_LIMITS, DEFAULT_MEMORY_REVIEW } from "../../../agent/memory/domain/memory.types"

/** Runtime configuration loaded from agent.config.json */
export interface IAgentConfig {
  maxIterations: number
  taskLabelLength: number
  maxTokens: number

  /** Access control strategy. Defaults to "approval". Runtime override in data/access.json takes precedence. */
  accessStrategy?: "open" | "public" | "allowlist" | "code" | "approval"

  /** For "allowlist" strategy: list of allowed Telegram user IDs */
  allowlist?: string[]

  /** For "code" strategy: the secret code users must send */
  accessCode?: string

  heartbeat: {
    intervalMin: number
  }

  session: {
    compactionThreshold: number
    recentKeep: number
  }

  /**
   * Memory subsystem configuration.
   * - `limits`: per-file character limits; oldest content is truncated from
   *   the top when a file exceeds its limit. Bounds system-prompt size.
   * - `review`: background self-improvement review — every N turns, promote
   *   durable facts from the conversation into MEMORY.md.
   */
  memory: {
    limits: MemoryLimits
    review: MemoryReviewConfig
  }

  s3: {
    /**
     * Optional periodic full-sweep backup. 0 disables it.
     * Sync is event-driven by default (fs.watch + diff).
     */
    syncIntervalSec: number
    /** Debounce window for fs.watch flushes, in ms. Default: 30000. */
    watcherDebounceMs?: number
  }

  tools: {
    spawnAgent: {
      timeoutMin: number
      outputLimit: number
    }
    browser: {
      outputLimit: number
    }
    webFetch: {
      maxChars: number
    }
  }

  /** Words/phrases that immediately cancel all running tasks. Case-insensitive. */
  stopPhrases: string[]

  /**
   * Files overwritten from .agent.example on every restart.
   * Only files listed here are touched — everything else is preserved.
   * Default: ["SOUL.md"]
   */
  managedFiles: string[]

  /**
   * Whether to sync skills from .agent.example on restart.
   * Only overwrites skills that exist in both .agent and .agent.example.
   * Skills only in .agent (user-created) are never deleted.
   * Default: true
   */
  syncSkills: boolean

  /**
   * MCP servers to connect to at runtime. Loaded by the McpModule on boot:
   * each entry becomes a connected MCP client whose tools are merged into
   * the global ToolGateway, so the LLM sees them alongside built-in tools.
   *
   * Sources, in priority order:
   *  1. `MCP_SERVERS_B64` env — base64(JSON array), populated by the deploy
   *     pipeline of whatever orchestrator hosts the runtime (managed source
   *     of truth). Base64 because the value is injected into a YAML manifest.
   *  2. This `mcps` field — used standalone, or merged with the env list
   *     (env entries override file entries with the same `name`).
   *
   * Disabled servers can be filtered out by setting `enabled: false`.
   */
  mcps?: IMcpServerConfig[]
}

/**
 * Connection config for a single MCP server. Same shape is used for both
 * `agent.config.json#mcps` and `MCP_SERVERS_B64` env values.
 */
export interface IMcpServerConfig {
  /** Unique key. MCP tools are namespaced as `${name}__${toolName}`. */
  name: string
  /**
   * Transport protocol. `streamableHttp` is the modern MCP HTTP transport,
   * `sse` is the legacy server-sent-events variant. `stdio` spawns a
   * subprocess — useful for local dev / unmanaged MCPs in standalone mode.
   */
  transport: "streamableHttp" | "sse" | "stdio"

  /** Endpoint URL (for streamableHttp / sse). */
  url?: string

  /** Command + args (for stdio transport only). */
  command?: string
  args?: string[]

  /**
   * How to authenticate the connection. `bearer` adds an `Authorization:
   * Bearer <authValue>` header. `header` interprets `authValue` as a literal
   * `Header-Name: value` line. `none` sends no auth header.
   */
  authType?: "none" | "bearer" | "header"
  authValue?: string | null

  /** Default true. Set to false to keep the entry registered but skip connect. */
  enabled?: boolean
}

/** Required subdirectories inside the agent directory */
export const AGENT_SUBDIRS = ["data", "sessions", "memory", "skills", "workspace"] as const

/**
 * Default list of managed files — synced from .agent.example on startup.
 * Can be overridden via agent.config.json `managedFiles` field.
 */
export const DEFAULT_MANAGED_FILES = ["SOUL.md"] as const

/** Default config values — used when agent.config.json is missing or partial */
export const AGENT_CONFIG_DEFAULTS: IAgentConfig = {
  maxIterations: 25,
  taskLabelLength: 60,
  maxTokens: 16384,

  heartbeat: {
    intervalMin: 30,
  },

  session: {
    compactionThreshold: 60,
    recentKeep: 20,
  },

  memory: {
    limits: { ...DEFAULT_MEMORY_LIMITS },
    review: { ...DEFAULT_MEMORY_REVIEW },
  },

  s3: {
    syncIntervalSec: 0,
    watcherDebounceMs: 30_000,
  },

  tools: {
    spawnAgent: {
      timeoutMin: 5,
      outputLimit: 4000,
    },
    browser: {
      outputLimit: 5000,
    },
    webFetch: {
      maxChars: 8000,
    },
  },

  stopPhrases: [
    "/stop",
    "stop", "abort", "cancel",
    "halt", "enough", "quit",
  ],

  managedFiles: [...DEFAULT_MANAGED_FILES],
  syncSkills: true,
}
