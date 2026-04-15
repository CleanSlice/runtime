import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const schema = z.object({
  query: z.string().describe("Search query to find relevant memory or conversation history"),
  maxResults: z.number().optional().default(5).describe("Maximum number of results to return (default: 5)"),
})

interface SearchResult {
  source: string
  text: string
  score: number
}

function scoreText(text: string, words: string[]): number {
  const lower = text.toLowerCase()
  return words.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0)
}

export const MemorySearchTool: Tool = {
  name: "memory_search",
  description: "Search agent memory and conversation history for relevant information. Use when you need to recall past conversations or stored knowledge.",
  schema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { query, maxResults } = schema.parse(params)
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const results: SearchResult[] = []

    // Search static memory files
    const memoryFiles = [
      join(ctx.agentDir, "MEMORY.md"),
      join(ctx.agentDir, "SOUL.md"),
      join(ctx.agentDir, "USER.md"),
    ]

    for (const filePath of memoryFiles) {
      if (!existsSync(filePath)) continue
      try {
        const text = await Bun.file(filePath).text()
        const lines = text.split("\n").filter(l => l.trim())
        for (const line of lines) {
          const score = scoreText(line, words)
          if (score > 0) {
            results.push({ source: filePath.replace(ctx.agentDir + "/", ""), text: line.trim(), score })
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    // Search daily memory files (memory/YYYY-MM-DD.md)
    const memoryDir = join(ctx.agentDir, "memory")
    if (existsSync(memoryDir)) {
      try {
        const files = await readdir(memoryDir)
        for (const file of files.filter(f => f.endsWith(".md"))) {
          const filePath = join(memoryDir, file)
          try {
            const text = await Bun.file(filePath).text()
            const lines = text.split("\n").filter(l => l.trim())
            for (const line of lines) {
              const score = scoreText(line, words)
              if (score > 0) {
                results.push({ source: `memory/${file}`, text: line.trim(), score })
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // memory dir not readable
      }
    }

    // Search session JSONL files
    const sessionsDir = join(ctx.agentDir, "data", "sessions")
    if (existsSync(sessionsDir)) {
      try {
        const files = await readdir(sessionsDir)
        const jsonlFiles = files.filter(f => f.endsWith(".jsonl"))

        for (const file of jsonlFiles) {
          const filePath = join(sessionsDir, file)
          try {
            const text = await Bun.file(filePath).text()
            const lines = text.split("\n").filter(l => l.trim())
            for (const line of lines) {
              let content = line
              try {
                const event = JSON.parse(line)
                content = event.text || event.content || event.message || line
                if (typeof content !== "string") content = JSON.stringify(content)
              } catch {
                // use raw line
              }
              const score = scoreText(content, words)
              if (score > 0) {
                results.push({ source: `sessions/${file}`, text: content.slice(0, 300), score })
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // sessions dir not readable
      }
    }

    results.sort((a, b) => b.score - a.score)
    return { results: results.slice(0, maxResults), total: results.length }
  },
}
