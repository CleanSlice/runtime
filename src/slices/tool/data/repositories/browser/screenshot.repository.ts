import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"

const schema = z.object({
  url: z.string().describe("URL to take a screenshot of"),
  fullPage: z.boolean().optional().default(true).describe("Capture full page height (default: true)"),
  width: z.number().optional().default(1280).describe("Viewport width in pixels"),
})

export const BrowserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description: "Take a screenshot of a website and send it to the user via Telegram. Supports full page screenshots.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { url, fullPage, width } = schema.parse(params)

    const home = process.env.HOME ?? "/home/dmitriyzhuk"
    const filename = `screenshot-${randomUUID()}.png`
    const outPath = `${home}/${filename}`

    // Use Playwright for proper full-page screenshots
    const { chromium } = await import("playwright")
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: width ?? 1280, height: 900 } })

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 })
    await page.screenshot({ path: outPath, fullPage: fullPage !== false })
    await browser.close()

    // Check file exists
    const file = Bun.file(outPath)
    const exists = await file.exists()
    if (!exists) return { error: "Screenshot failed — file not created" }

    // Analyze screenshot with Claude vision
    let visionDescription: string | undefined
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (oauthToken) {
      try {
        const imgBuffer = await file.arrayBuffer()
        const base64 = Buffer.from(imgBuffer).toString("base64")
        const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${oauthToken}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
                { type: "text", text: "Describe exactly what you see on this screenshot: page content, visible text, forms, buttons, errors, dialogs, current state." },
              ],
            }],
          }),
        })
        const visionData = await visionRes.json() as { content?: Array<{ type: string; text?: string }> }
        visionDescription = visionData?.content?.find(c => c.type === "text")?.text
      } catch (_e) {
        // vision failed, continue without it
      }
    }

    // Send via Telegram
    const telegramToken = process.env.TELEGRAM_TOKEN
    const chatId = ctx.from
    if (telegramToken && chatId && chatId !== "cron") {
      const form = new FormData()
      form.append("chat_id", chatId)
      form.append("caption", `📸 ${url}`)
      form.append("photo", new Blob([await file.arrayBuffer()], { type: "image/png" }), "screenshot.png")

      const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendPhoto`, {
        method: "POST",
        body: form,
      })
      const data = await res.json() as { ok: boolean; description?: string }

      await Bun.spawn(["rm", "-f", outPath]).exited

      if (data.ok) return { ok: true, sent: true, url, vision: visionDescription }
      return { error: `Telegram send failed: ${data.description}` }
    }

    return { ok: true, sent: false, path: outPath, url, vision: visionDescription }
  },
}
