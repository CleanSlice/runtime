import type { Tool } from "./domain/tool.types"
import { zodToJsonSchema } from "zod-to-json-schema"

export class ToolRegistry {
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

  toAnthropicTools(): Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema) as Record<string, unknown>,
    }))
  }
}
