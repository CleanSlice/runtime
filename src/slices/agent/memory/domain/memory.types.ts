export interface MemoryEntry {
  id: string
  content: string
  source: string  // which md file
  ts: number
}

/**
 * Per-file character limits for memory files. When a file exceeds its limit
 * the OLDEST content is dropped (truncated from the top) to fit. Character
 * counts are used instead of tokens because they are model-independent.
 *
 * Configurable via `agent.config.json` → `memory.limits`.
 */
export interface MemoryLimits {
  /** SOUL.md — agent identity/persona. */
  soul: number
  /** USER.md — what the agent knows about the user. */
  user: number
  /** MEMORY.md — agent's curated long-term notes. */
  memory: number
  /** HEARTBEAT.md — periodic status file. */
  heartbeat: number
  /** memory/YYYY-MM-DD.md — daily append-only memory log. */
  daily: number
}

/**
 * Default limits. Mirrors Hermes' bounded-memory sizing (~2.75 chars/token):
 * memory ≈ 800 tokens, user ≈ 500 tokens. `soul` is sized to comfortably fit
 * the shipped persona; `daily` allows roughly a day of notes (the prompt reads
 * yesterday + today, so the injected window is ~2× this value).
 */
export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  soul: 6000,
  user: 1375,
  memory: 2200,
  heartbeat: 1000,
  daily: 4000,
}

/** Maps a curated memory filename to its limit key. */
export const MEMORY_FILE_LIMITS: Record<string, keyof MemoryLimits> = {
  "SOUL.md": "soul",
  "USER.md": "user",
  "MEMORY.md": "memory",
  "HEARTBEAT.md": "heartbeat",
}

/**
 * Background self-improvement review. Every `everyTurns` completed turns the
 * agent forks an auxiliary-model pass over the recent conversation and
 * promotes durable facts into MEMORY.md, so knowledge persists beyond the
 * 2-day daily-memory window. Runs after the response is delivered and never
 * touches the main session's prompt cache.
 *
 * Configurable via `agent.config.json` → `memory.review`.
 */
export interface MemoryReviewConfig {
  /** Master switch for the background review. */
  enabled: boolean
  /** Run the review once every N completed turns. 0 disables it. */
  everyTurns: number
}

export const DEFAULT_MEMORY_REVIEW: MemoryReviewConfig = {
  enabled: true,
  everyTurns: 10,
}

/** Markdown heading under which the background review files its findings. */
export const MEMORY_LEARNED_HEADING = "## Learned"
