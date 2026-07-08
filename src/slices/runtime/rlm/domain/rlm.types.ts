// Mirrors ranch's api/src/slices/rlm/domain/rlm.types.ts IRlmContextRef /
// IRlmJobResult exactly - this is the wire contract between the two repos.
export type RlmContextRef =
  | { type: "knowledge"; knowledgeId: string }
  | { type: "source"; sourceId: string }
  | { type: "agentFile"; agentId: string; path: string }

export interface RlmJobResult {
  answer: string
  iterations: number
  toolCalls: number
  durationMs: number
  error?: string
}
