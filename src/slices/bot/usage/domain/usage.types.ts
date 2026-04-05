export interface ICredentialUsage {
  inputTokens: number
  outputTokens: number
  callCount: number
}

export interface IDailyUsage {
  date: string                                    // "YYYY-MM-DD" UTC
  totalInputTokens: number
  totalOutputTokens: number
  totalCallCount: number
  byCredential: Record<string, ICredentialUsage> // credentialId → stats
  reportedAt: string | null                      // ISO timestamp or null
}
