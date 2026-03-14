import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { mkdirSync } from "fs"

const schema = z.object({
  url: z.string().describe("URL to take a screenshot of"),
})

export const BrowserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description: "Take a screenshot of a website and send it to the user via Telegram. Returns the file path.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { url } = schema.parse(params)

    const screenshotsDir = `${ctx.agentDir}/screenshots`
    mkdirSync(screenshotsDir, { recursive: true })
    const outPath = `${screenshotsDir}/${randomUUID()}.png`

    // Use chromium to take screenshot
    const proc = Bun.spawn([
      "chromium-browser",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      `--screenshot=${outPath}`,
      "--window-size=1280,900",
      url,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    })

    await proc.exited

    // Check file exists
    const file = Bun.file(outPath)
    const exists = await file.exists()
    if (!exists) {
      return { error: "Screenshot failed — file not created" }
    }

    // Send via Telegram if we have a chat_id
    const telegramToken = process.env.TELEGRAM_TOKEN
    const chatId = ctx.from
    if (telegramToken && chatId && chatId !== "cron") {
      {
        const form = new FormData()
        form.append("chat_id", chatId)
        form.append("caption", `Screenshot: ${url}`)
        form.append("photo", new Blob([await file.arrayBuffer()], { type: "image/png" }), "screenshot.png")

        const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendPhoto`, {
          method: "POST",
          body: form,
        })
        const data = await res.json() as { ok: boolean }
        if (data.ok) return { ok: true, sent: true, url, path: outPath }
      }
    }

    return { ok: true, sent: false, path: outPath, url }
  },
}
