import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  url: z.string().url().describe("URL to fetch"),
  method: z.string().optional().default("GET"),
  body: z.string().optional(),
  headers: z.record(z.string()).optional(),
})

export const HttpTool: Tool = {
  name: "http",
  description: "Make an HTTP request and return the response",
  schema,
  // Hostname only — paths/queries may carry tokens (FR-008).
  stepLabel(params: unknown): string | undefined {
    const p = schema.safeParse(params)
    if (!p.success) return undefined
    try {
      return `Fetch ${new URL(p.data.url).hostname}`
    } catch {
      return undefined
    }
  },
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { url, method, body, headers } = schema.parse(params)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(url, {
        method,
        body: body ?? undefined,
        headers: headers ?? undefined,
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, body: text.slice(0, 50_000) }
    } catch (err) {
      if (controller.signal.aborted) return { error: "Request timed out after 30s" }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  },
}
