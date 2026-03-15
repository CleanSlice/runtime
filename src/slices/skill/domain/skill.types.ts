export interface Skill {
  name: string
  description: string
  path: string       // absolute path to SKILL.md
  content: string    // full SKILL.md content (without frontmatter)
}
