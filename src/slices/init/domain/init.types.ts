/** Runtime configuration loaded from agent.config.json */
export interface IAgentConfig {
  maxIterations: number
  taskLabelLength: number

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
}

/** Required subdirectories inside the agent directory */
export const AGENT_SUBDIRS = ["data", "sessions", "memory", "skills"] as const

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
}
