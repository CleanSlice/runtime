/** Runtime configuration loaded from agent.config.json */
export interface IAgentConfig {
  maxIterations: number
  taskLabelLength: number

  /** Access control strategy. Defaults to "approval". */
  accessStrategy?: "open" | "allowlist" | "code" | "approval"

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
    syncIntervalSec: number
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
}

/** Required subdirectories inside the agent directory */
export const AGENT_SUBDIRS = ["data", "sessions", "memory", "skills", "workspace"] as const

/** Default config values — used when agent.config.json is missing or partial */
export const AGENT_CONFIG_DEFAULTS: IAgentConfig = {
  maxIterations: 25,
  taskLabelLength: 60,

  heartbeat: {
    intervalMin: 30,
  },

  session: {
    compactionThreshold: 60,
    recentKeep: 20,
  },

  s3: {
    syncIntervalSec: 60,
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
    "стоп", "остановись", "отмена",
    "стоп", "зупинись", "скасуй",
  ],
}
