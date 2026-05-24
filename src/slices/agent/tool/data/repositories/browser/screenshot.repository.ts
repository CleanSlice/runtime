import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { ensurePlaywright, chromiumPath } from "./ensure-playwright"
import { MessagePartTypes } from "../../../../../setup/channel/domain/channel.types"
import { createLogger } from "../../../../../setup/logger"

const log = createLogger("browser_screenshot")

const schema = z.object({
  url: z.string().describe("URL to take a screenshot of"),
  fullPage: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Capture full page height (default: false — viewport-only). " +
        "Setting true on lazy-load pages (X, Instagram) routinely blows " +
        "the 30s deadline because of scroll-and-shoot.",
    ),
  width: z.number().optional().default(1280).describe("Viewport width in pixels"),
})

export const BrowserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description:
    "Take a viewport-only screenshot of a website and post it to the current chat as an image. " +
    "For multi-step browser flows (login, fill, click, submit) use browser_play instead.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { url, fullPage, width } = schema.parse(params)

    const home = process.env.HOME ?? "/home/agent"
    const filename = `screenshot-${randomUUID()}.png`
    const outPath = `${home}/${filename}`

    const { chromium } = await ensurePlaywright()
    // Same launch args as browser_play — required in containers:
    //   --no-sandbox             k8s pods have no user-namespaces support
    //   --disable-dev-shm-usage  /dev/shm defaults to 64MB; without this
    //                            Chromium crashes on shared-mem allocations
    //   --disable-gpu            headless has no GPU; the GPU process is a
    //                            known source of "Target has been closed"
    //                            crashes on JS-heavy SPAs (X, Instagram).
    const browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    })
    try {
      const page = await browser.newPage({ viewport: { width: width ?? 1280, height: 900 } })

      // `domcontentloaded` (not `networkidle`). X / Instagram are SPAs with
      // websockets and long-polling that never let the network go idle —
      // `networkidle` always hits the 30s timeout there. DCL fires as soon
      // as the HTML is parsed, which is what we want for a screenshot.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
      // Give the page a beat to paint above-the-fold content.
      await page.waitForTimeout(1500)
      await page.screenshot({ path: outPath, fullPage: fullPage === true })
    } finally {
      await browser.close().catch(() => {})
    }

    const file = Bun.file(outPath)
    if (!(await file.exists())) {
      return { error: "Screenshot failed — file not created" }
    }

    // ── Deliver: prefer the current channel (bridle, web, etc.) as a
    // proper image part. Falls back to Telegram's native sendPhoto when
    // the chat is on Telegram. If neither applies (internal / cron), the
    // file path is returned so the LLM can decide what to do with it.
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN
    const chatId = ctx.from
    const isTelegramChannel = ctx.channel === "telegram"

    if (telegramToken && chatId && chatId !== "cron" && isTelegramChannel) {
      const form = new FormData()
      form.append("chat_id", chatId)
      form.append("caption", `📸 ${url}`)
      form.append(
        "photo",
        new Blob([await file.arrayBuffer()], { type: "image/png" }),
        "screenshot.png",
      )
      const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendPhoto`, {
        method: "POST",
        body: form,
      })
      const data = (await res.json()) as { ok: boolean; description?: string }
      await Bun.spawn(["rm", "-f", outPath]).exited
      return data.ok
        ? { ok: true, sentTo: "telegram", url }
        : { error: `Telegram send failed: ${data.description}` }
    }

    if (ctx.channel && ctx.channel !== "internal" && ctx.channel !== "cron") {
      try {
        const buf = await file.arrayBuffer()
        const base64 = Buffer.from(buf).toString("base64")
        await ctx.send(`📸 ${url}`, [
          { type: MessagePartTypes.Image, base64, mediaType: "image/png" },
        ])
        await Bun.spawn(["rm", "-f", outPath]).exited
        return { ok: true, sentTo: ctx.channel, url }
      } catch (e) {
        log.warn(`channel send failed: ${e}`)
      }
    }

    return { ok: true, sentTo: null, path: outPath, url }
  },
}
