import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const BRAVE_API_KEY = "BSAarJNjvrP0D-pDvRDZ664hhl1Bp0u"
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"

const schema = z.object({
  query: z.string().describe("Search query"),
  count: z.number().optional().default(5).describe("Number of results to return"),
})

export const WebSearchTool: Tool = {
  name: "web_search",
  description: "Search the web using Brave Search and return results",
  schema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { query, count } = schema.parse(params)
    const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${count}`
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
    })
    if (!res.ok) {
      return { error: `Brave Search API error: ${res.status} ${res.statusText}` }
    }
    const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
    const results = data?.web?.results ?? []
    return results.map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }))
  },
}
