export interface ICredentialStatus {
  id: string                  // "oauth-0", "api-0"
  active: boolean             // is this the currentClientIndex?
  cooldownUntilMs: number     // epoch ms; 0 = available
  msUntilAvailable: number    // 0 = available now
  consecutive429s: number
}

export interface ILlmResourceStatus {
  provider: string
  model: string
  fallbackModel?: string
  contextWindow: number       // tokens for the active model
  maxOutputTokens: number
  credentials: ICredentialStatus[]
  activeCredential: string
  anyAvailableNow: boolean
  soonestAvailableMs: number  // 0 if any available
  primaryOverloaded?: boolean // true while the circuit-breaker has the primary model parked
}

export interface ISystemResourceStatus {
  rssBytes: number
  memoryLimitBytes?: number     // undefined if uncapped
  memoryUsagePct?: number
  cpuPercent?: number           // sampled over ~100ms
  cpuQuotaPct?: number          // 100 = 1 core, 200 = 2 cores
  cgroupVersion: "v1" | "v2" | "host"
}

export interface ILastTurnStats {
  elapsedMs: number
  retries: number
  rateLimited: boolean
  overloaded: boolean
  model: string
  occurredAt: number
}

export interface IResourceSnapshot {
  llm: ILlmResourceStatus
  usage: {
    todayInputTokens: number
    todayOutputTokens: number
    todayCallCount: number
  }
  system: ISystemResourceStatus
  lastTurn?: ILastTurnStats
  capturedAt: number
}
