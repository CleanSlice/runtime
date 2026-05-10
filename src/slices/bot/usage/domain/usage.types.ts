export interface ICredentialUsage {
  inputTokens: number
  outputTokens: number
  callCount: number
}

export interface IModelUsage {
  inputTokens: number
  outputTokens: number
  callCount: number
  /** Last credential that produced a call for this model — for attribution. */
  llmCredentialId?: string
}

export interface IDailyUsage {
  date: string                                    // "YYYY-MM-DD" UTC
  totalInputTokens: number
  totalOutputTokens: number
  totalCallCount: number
  /** Per-credential rollup — used by older OpenClaw API path. */
  byCredential: Record<string, ICredentialUsage>
  /**
   * Per-model rollup — required by ranch's POST /agents/:id/usage endpoint
   * (key is the model name, e.g. "claude-sonnet-4-6"). Optional so older
   * usage.json files on disk still parse.
   */
  byModel?: Record<string, IModelUsage>
  reportedAt: string | null                      // ISO timestamp or null
}
