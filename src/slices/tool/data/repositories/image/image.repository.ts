import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  url: z.string().describe("URL or local file path of the image to analyze"),
  prompt: z.string().optional().default("Describe this image").describe("Prompt to send with the image"),
})

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mediaType: string }> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`)
    const contentType = res.headers.get("content-type") ?? "image/jpeg"
    const mediaType = contentType.split(";")[0].trim()
    const buffer = await res.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    return { base64, mediaType }
  } else {
    // Local file path
    const file = Bun.file(url)
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    const mediaType = file.type || "image/jpeg"
    return { base64, mediaType }
  }
}

export const ImageAnalyzeTool: Tool = {
  name: "image_analyze",
  description: "Analyze an image from a URL or local file path using Claude vision",
  schema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { url, prompt } = schema.parse(params)
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (!oauthToken) {
      return { error: "CLAUDE_CODE_OAUTH_TOKEN environment variable is not set" }
    }

    const { base64, mediaType } = await fetchImageAsBase64(url)

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${oauthToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      return { error: `Anthropic API error: ${res.status} ${errText}` }
    }

    const data = await res.json() as { content?: Array<{ type: string; text?: string }> }
    const text = data?.content?.find(c => c.type === "text")?.text ?? ""
    return { description: text }
  },
}
