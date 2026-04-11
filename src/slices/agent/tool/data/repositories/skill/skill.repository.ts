import { z } from "zod"
import { join } from "path"
import { mkdirSync } from "fs"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  name: z.string().describe("Skill name (slug, e.g. 'github', 'trello', 'weather')"),
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
