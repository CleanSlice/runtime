import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { mkdirSync } from "fs"

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string() }),
  z.object({ kind: z.literal("click"), selector: z.string() }),
  z.object({ kind: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.object({ kind: z.literal("press"), selector: z.string(), key: z.string() }),
  z.object({ kind: z.literal("wait"), ms: z.number() }),
  z.object({ kind: z.literal("waitForSelector"), selector: z.string(), timeout: z.number().optional() }),
  z.object({ kind: z.literal("evaluate"), code: z.string() }),
  z.object({ kind: z.literal("screenshot"), fullPage: z.boolean().optional() }),
  z.object({ kind: z.literal("getText"), selector: z.string() }),
])

const schema = z.object({
  profile: z.string().default("default").describe("Browser profile name (separate persistent session per profile)"),
  actions: z.array(actionSchema).describe("List of browser actions to execute in sequence"),
})

export const PlaywrightTool: Tool = {
  name: "browser_play",
  description: `Full Playwright browser control with persistent sessions (cookies, localStorage saved between calls).
Use this to: log into websites, automate web tasks, scrape authenticated pages, interact with web apps.
Supports: navigate, click, fill, press, wait, waitForSelector, evaluate (JS), screenshot, getText.
Each 'profile' has its own persistent session — login once, reuse forever.
Example: log in to Instagram with profile="instagram", then future calls with same profile stay logged in.`,
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { profile, actions } = schema.parse(params)

    const home = process.env.HOME ?? "/home/dmitriyzhuk"

    // Isolate browser profile per user — each user gets their own cookies/session
    // Profile "instagram" for user 55212224 → "55212224-instagram"
    // This prevents session leaks between users
    const safeUserId = ctx.from.replace(/[^a-zA-Z0-9_\-.]/g, "_")
    const isolatedProfile = ctx.from && ctx.from !== "cron" && ctx.from !== "heartbeat"
      ? `${safeUserId}-${profile}`
      : profile

    const profileDir = `${home}/.cleanslice-browser-profiles/${isolatedProfile}`
    mkdirSync(profileDir, { recursive: true })
    console.log(`[browser_play] profile=${isolatedProfile} user=${ctx.from}`)

    const { chromium } = await import("playwright")

    const browser = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      viewport: { width: 1280, height: 900 },
    })

    const page = browser.pages()[0] ?? await browser.newPage()
    const results: unknown[] = []

    try {
      for (const action of actions) {
        switch (action.kind) {
          case "navigate": {
            await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 })
            results.push({ action: "navigate", url: action.url, title: await page.title() })
            break
          }
          case "click": {
            // Try exact selector first, fallback to role=button with text
            const el = await page.$(action.selector)
            if (el) {
              await el.click({ timeout: 10000 })
            } else if (action.selector.includes(":has-text(") || action.selector.includes("text=")) {
              await page.click(action.selector, { timeout: 10000 })
            } else {
              // Last resort: try as text match on div[role=button]
              await page.click(action.selector, { timeout: 10000 })
            }
            results.push({ action: "click", selector: action.selector })
            break
          }
          case "fill": {
            await page.fill(action.selector, action.value, { timeout: 10000 })
            results.push({ action: "fill", selector: action.selector })
            break
          }
          case "press": {
            await page.press(action.selector, action.key)
            results.push({ action: "press", key: action.key })
            break
          }
          case "wait": {
            await new Promise(r => setTimeout(r, action.ms))
            results.push({ action: "wait", ms: action.ms })
            break
          }
          case "waitForSelector": {
            await page.waitForSelector(action.selector, { timeout: action.timeout ?? 15000 })
            results.push({ action: "waitForSelector", selector: action.selector, found: true })
            break
          }
          case "evaluate": {
            const result = await page.evaluate(action.code)
            results.push({ action: "evaluate", result })
            break
          }
          case "screenshot": {
            const filename = `screenshot-${randomUUID()}.png`
            const outPath = `${home}/${filename}`
            await page.screenshot({ path: outPath, fullPage: action.fullPage !== false })

            // Analyze the screenshot with Claude vision so bot knows what's on screen
            let visionDescription: string | undefined
            const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
            if (oauthToken) {
              try {
                const imgFile = Bun.file(outPath)
                const imgBuffer = await imgFile.arrayBuffer()
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

            const telegramToken = process.env.TELEGRAM_TOKEN
            const chatId = ctx.from
            if (telegramToken && chatId && chatId !== "cron") {
              const file = Bun.file(outPath)
              const form = new FormData()
              form.append("chat_id", chatId)
              form.append("caption", `📸 ${await page.url()}`)
              form.append("photo", new Blob([await file.arrayBuffer()], { type: "image/png" }), "screenshot.png")
              const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendPhoto`, { method: "POST", body: form })
              await Bun.spawn(["rm", "-f", outPath]).exited
              results.push({ action: "screenshot", sent: (await res.json() as { ok: boolean }).ok, vision: visionDescription })
            } else {
              results.push({ action: "screenshot", path: outPath, vision: visionDescription })
            }
            break
          }
          case "getText": {
            const text = await page.textContent(action.selector, { timeout: 10000 })
            results.push({ action: "getText", selector: action.selector, text })
            break
          }
        }
      }

      const currentUrl = page.url()
      const title = await page.title()
      return { ok: true, profile: isolatedProfile, url: currentUrl, title, results }

    } catch (err) {
      return { ok: false, profile: isolatedProfile, error: String(err), results }
    } finally {
      await browser.close()
    }
  },
}
