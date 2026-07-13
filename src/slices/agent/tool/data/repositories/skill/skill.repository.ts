import { z } from "zod"
import { join } from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import type { Tool, ToolContext } from "../../../domain/tool.types"

// Skill names are used as directory names under agentDir/skills — restrict to
// a plain slug so "../" can never escape the skills directory.
const skillNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Skill name must be a slug: letters, digits, dashes, underscores")

const schema = z.object({
  name: skillNameSchema.describe("Skill name (slug, e.g. 'github', 'trello', 'weather')"),
  description: z.string().describe("One-line description used for skill matching against user messages"),
  content: z.string().describe("Full SKILL.md body content (without frontmatter)"),
})

export const SkillWriteTool: Tool = {
  name: "skill_write",
  description:
    "Create or update a skill in the agent's skills directory (.agent/skills/<name>/SKILL.md). " +
    "The skill is immediately reloaded and available after writing. " +
    "Use this when the user asks you to create, save, or remember a new skill or workflow.",
  schema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { name, description, content } = schema.parse(params)

    const skillDir = join(ctx.agentDir, "skills", name)
    const skillPath = join(skillDir, "SKILL.md")

    // Ensure skill directory exists
    mkdirSync(skillDir, { recursive: true })

    const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n`
    await Bun.write(skillPath, frontmatter + content)

    // Reload skills so the new skill is immediately active without /skills reload
    if (ctx.reloadSkills) {
      await ctx.reloadSkills()
    }

    return { success: true, path: skillPath, name, description }
  },
}

const deleteSchema = z.object({
  name: skillNameSchema.describe("Skill name to delete (slug, as listed in the skill catalog)"),
})

export const SkillDeleteTool: Tool = {
  name: "skill_delete",
  description:
    "Delete a skill from the agent's skills directory (.agent/skills/<name>/). " +
    "Only agent-level skills can be deleted — bundled runtime skills cannot. " +
    "The skill catalog is immediately reloaded after deletion. " +
    "Use this when the user asks you to remove, delete, or forget a skill.",
  schema: deleteSchema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { name } = deleteSchema.parse(params)

    const skillDir = join(ctx.agentDir, "skills", name)
    if (!existsSync(skillDir)) {
      return { success: false, error: `Skill "${name}" not found in agent skills — only agent-level skills can be deleted` }
    }

    rmSync(skillDir, { recursive: true, force: true })

    // Reload so the deleted skill disappears from the catalog without /skills reload
    if (ctx.reloadSkills) {
      await ctx.reloadSkills()
    }

    return { success: true, name }
  },
}
