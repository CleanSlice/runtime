import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  url: z.string().describe("URL to fetch and extract text from"),
  selector: z.string().optional().describe("Optional CSS selector to extract specific element"),
})

export const BrowserTool: Tool = {
  name: "browser",
  description: "Fetch a web page and extract its text content. Use for reading web pages, checking websites, scraping data.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { url, selector } = schema.parse(params)

    const proc = Bun.spawn([
      "chromium-browser",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      url,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [html, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    await proc.exited

    // Extract text from HTML (simple approach)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, ctx.agentConfig?.tools.browser.outputLimit ?? 5000)

    return {
      url,
      text,
      length: text.length,
      error: stderr.slice(0, 200) || undefined,
    }
  },
}
