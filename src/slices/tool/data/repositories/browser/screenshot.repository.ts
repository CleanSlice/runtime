import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { mkdirSync } from "fs"

const schema = z.object({
  url: z.string().describe("URL to take a screenshot of"),
  fullPage: z.boolean().optional().default(true).describe("Capture full page (default: true)"),
  width: z.number().optional().default(1280).describe("Viewport width in pixels"),
})

export const BrowserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description: "Take a screenshot of a website and send it to the user via Telegram. Returns the file path.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { url, fullPage, width } = schema.parse(params)

    // Snap chromium can only write to $HOME — use home dir
    const home = process.env.HOME ?? "/home/dmitriyzhuk"
    const filename = `screenshot-${randomUUID()}.png`
    const outPath = `${home}/${filename}`

    // Use chromium to take screenshot
    const args = [
      "chromium-browser",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--screenshot=${outPath}`,
      `--window-size=${width ?? 1280},900`,
    ]
    if (fullPage !== false) args.push("--full-page-screenshot")
    args.push(url)

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    })

    await proc.exited
    await new Promise(r => setTimeout(r, 500)) // wait for file flush

    // Check file exists
    const file = Bun.file(outPath)
    const exists = await file.exists()
    if (!exists) {
      return { error: "Screenshot failed — file not created" }
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

      // Cleanup
      await Bun.spawn(["rm", "-f", outPath]).exited

      if (data.ok) return { ok: true, sent: true, url }
      return { error: `Telegram send failed: ${data.description}` }
    }

    return { ok: true, sent: false, path: outPath, url }
  },
}
