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
