import type { Tool, ToolContext } from "./tool.types"

export class ToolService {
  private tools: Map<string, Tool> = new Map()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return [...this.tools.values()]
  }

  async execute(name: string, params: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) return { error: `Unknown tool: ${name}` }
    return tool.execute(params, ctx)
  }

  /**
   * Build a "## Tooling" section for the system prompt
   * from the actually registered tools.
   */
  buildToolingPrompt(): string {
    return ToolService.buildToolingPromptFrom(this.getAll())
  }

  /**
   * Build a "## Tooling" section from any Tool array.
   * Usable without a ToolService instance.
   */
  static buildToolingPromptFrom(tools: Tool[]): string {
    if (tools.length === 0) return ""

    const lines = [
      "## Tooling",
      "",
      "You have the following tools. Use them — never simulate results.",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "",
    ]

    for (const tool of tools) {
      lines.push(`- \`${tool.name}\` — ${tool.description}`)
    }

    lines.push(
      "",
      "### Rules",
      "- Every claim about an action MUST be backed by an actual tool call and its real result.",
      "- Never narrate actions you haven't performed. No tool call = no claim.",
      "- If a tool returns an error — report the real error. Don't invent success.",
      "- If you don't have a tool for something — say so honestly.",
    )

    return lines.join("\n")
  }
}
