import type { Tool, ToolContext } from "./tool.types"

const STUB_MAX_CHARS = 80

/** First sentence of a description, cut to one bounded line. */
function stub(description: string): string {
  const firstLine = description.split("\n").find(l => l.trim()) ?? ""
  const sentence = firstLine.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? firstLine.trim()
  return sentence.length > STUB_MAX_CHARS ? sentence.slice(0, STUB_MAX_CHARS - 1).trimEnd() + "…" : sentence
}

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
   *
   * With `opts.core`, only those tools keep their full description; every
   * other tool is a one-line stub and `tool_describe` hands out the rest on
   * demand, so the catalogue stays within its budget however many MCP tools
   * are connected (CLEAN-150 US2).
   */
  static buildToolingPromptFrom(tools: Tool[], opts?: { core?: string[] }): string {
    if (tools.length === 0) return ""

    const lines = [
      "## Tooling",
      "",
      "Tool availability (filtered by policy):",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "",
    ]

    const core = opts?.core ? new Set(opts.core) : undefined
    let stubbed = 0
    for (const tool of tools) {
      if (!core || core.has(tool.name)) {
        lines.push(`- \`${tool.name}\` — ${tool.description}`)
      } else {
        lines.push(`- \`${tool.name}\` — ${stub(tool.description)}`)
        stubbed++
      }
    }
    if (stubbed > 0) {
      lines.push("", `${stubbed} tool${stubbed === 1 ? "" : "s"} above show a one-line summary. Call \`tool_describe\` with the name for the full description and parameters before using one.`)
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
