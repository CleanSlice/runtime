import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  url: z.string().url().describe("URL to fetch and convert to readable text"),
  maxChars: z.number().optional().default(8000).describe("Maximum characters to return (default: 8000)"),
})

export const WebFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a URL and return its content as clean readable text (markdown-style). Better than browser for reading articles.",
  schema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { url, maxChars } = schema.parse(params)

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CleansliceBot/1.0; +https://cleanslice.ai)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    })

    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${res.statusText}`, url }
    }

    const contentType = res.headers.get("content-type") ?? ""
    const html = await res.text()

    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return { url, content: html.slice(0, maxChars ?? 8000), contentType }
    }

    // Strip scripts and styles
    const cleaned = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")

    // Convert common block elements to newlines
    const withNewlines = cleaned
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n---\n")

    // Strip remaining tags
    const text = withNewlines
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()

    const limit = maxChars ?? 8000
    const content = text.slice(0, limit)

    return {
      url,
      content,
      length: content.length,
      truncated: text.length > limit,
    }
  },
}
