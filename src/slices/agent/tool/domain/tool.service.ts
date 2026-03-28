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
   * Build tooling + tool call style sections from any Tool array.
   * Usable without a ToolService instance.
   */
  static buildToolingPromptFrom(tools: Tool[]): string {
    if (tools.length === 0) return ""

    const lines = [
      "## Tooling",
      "",
      "Tool availability (filtered by policy):",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "",
    ]

    for (const tool of tools) {
      lines.push(`- \`${tool.name}\` — ${tool.description}`)
    }

    lines.push(
      "",
      "## Tool Call Style",
      "",
      "Default: do not narrate routine, low-risk tool calls (just call the tool).",
      "Narrate only when it helps: multi-step work, sensitive actions (e.g. deletions), or when the user explicitly asks.",
      "Keep narration brief and value-dense; avoid repeating obvious steps.",
      "",
      "- If a tool can answer the question — call it immediately. No preamble.",
      "- Every claim MUST be backed by an actual tool call result. No tool call = no claim.",
      "- If a tool returns an error — report the real error. Do not invent success.",
      "- If no tool exists for the request — say so honestly.",
    )

    return lines.join("\n")
  }
}
