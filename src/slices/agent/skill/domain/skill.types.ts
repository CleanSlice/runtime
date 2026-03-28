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

// ─── Skill ───────────────────────────────────────────────────────────────────

export interface Skill {
  name: string
  description: string
  path: string             // absolute path to SKILL.md
  content: string          // full SKILL.md content (without frontmatter)
  source: SkillSource      // where this skill was loaded from
  metadata?: SkillMetadata
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
