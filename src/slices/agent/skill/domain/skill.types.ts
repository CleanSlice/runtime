// ─── Skill Metadata ──────────────────────────────────────────────────────────

export interface SkillRequires {
  bins?: string[]          // required binaries (e.g. ["gh", "jq"])
  env?: string[]           // required env vars (e.g. ["GITHUB_TOKEN"])
}

export interface SkillMetadata {
  emoji?: string           // visual identifier (e.g. "🔧")
  always?: boolean         // always include in prompt (default false)
  requires?: SkillRequires
}

export type SkillSource = "bundled" | "installed" | "agent"

// ─── Skill Summary (lightweight — for system prompt catalog) ─────────────────

export interface SkillSummary {
  name: string
  description: string
  metadata?: SkillMetadata
  /** Why the skill cannot be loaded right now (missing env / binary), shown in the catalogue. */
  unavailable?: string
}

/** How skills enter a turn: pulled by the model with `skill_load`, or the legacy keyword matcher. */
export type SkillSelection = "model" | "keyword"

export interface SkillServiceOptions {
  selection: SkillSelection
  /** A loaded skill stays active this many turns after its last use. */
  retainTurns: number
  /** Environment seen by `requires.env` checks. */
  env: Record<string, string | undefined>
  /** Binary lookup for `requires.bins` checks. */
  hasBin: (bin: string) => boolean
}

export interface LoadedSkillInfo {
  name: string
  chars: number
  retainedForTurns: number
}

// ─── Skill (full — loaded on demand) ─────────────────────────────────────────

export interface Skill extends SkillSummary {
  path: string             // absolute path to SKILL.md
  content: string          // full SKILL.md content (without frontmatter)
  source: SkillSource      // where this skill was loaded from
}

// ─── Registry ────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  name: string
  description: string
  repo: string             // GitHub repo (e.g. "cleanslice/skills")
  path: string             // path within repo (e.g. "skills/github")
  requires?: SkillRequires
  emoji?: string
}

export interface SkillRegistry {
  version: number
  skills: RegistryEntry[]
}
