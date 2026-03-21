import { z } from "zod"
import type { Tool, ToolContext } from "../domain/tool.types"

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
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { url, method, body, headers } = schema.parse(params)
    const res = await fetch(url, {
      method,
      body: body ?? undefined,
      headers: headers ?? undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text }
  },
}
