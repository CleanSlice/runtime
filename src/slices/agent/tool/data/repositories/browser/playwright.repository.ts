import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { mkdirSync, existsSync } from "fs"
import { dirname } from "path"
import { ensurePlaywright, chromiumPath } from "./ensure-playwright"
import { profileStatePath } from "./browserLogin.repository"

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
  profile: z
    .string()
    .default("default")
    .describe(
      "Profile name — picks the persistent state file used for cookies/localStorage. Pair with browser_login to authenticate once, then reuse here.",
    ),
  actions: z.array(actionSchema).describe("List of browser actions to execute in sequence"),
})

export const PlaywrightTool: Tool = {
  name: "browser_play",
  description: `Full Playwright browser control with persistent sessions. Cookies + localStorage are stored as JSON under .agent/browser-state/<user>-<profile>.json — they survive container restarts via the existing S3 sync.

Supports: navigate, click, fill, press, wait, waitForSelector, evaluate (JS), screenshot, getText.

Login flow for sites that need authentication (Instagram, Meta Ads, PayPal, etc.):

1. Try browser_play. If the navigated URL ends up on a /login or /accounts/login path, the tool returns { needsLogin: true, hint }.
2. Call browser_login with the SAME profile — it returns a vncUrl.
3. Forward vncUrl to the user verbatim. Wait for them to confirm they finished signing in.
4. Call browser_login_done with the same profile. Cookies are captured into the local state file.
5. Retry browser_play. Now it runs logged in.

Never tell the user to "open instagram.com and log in yourself" — the login MUST happen in the pool's browser via vncUrl, otherwise cookies don't land on the profile.`,
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { profile, actions } = schema.parse(params)

    const home = process.env.HOME ?? "/tmp"
    const { chromium } = await ensurePlaywright()

    const stateFile = profileStatePath(ctx, profile)
    mkdirSync(dirname(stateFile), { recursive: true })
    const hadState = existsSync(stateFile)
    console.log(`[browser_play] profile=${profile} user=${ctx.from} state=${stateFile} exists=${hadState}`)

    // The extension may have written the file in the wrapper format
    // `{ userAgent, storageState: { cookies, origins } }` — replay the
    // captured UA on the Playwright context so sites that bind cookies
    // to a fingerprint (Instagram, Meta) accept the session. Legacy
    // files without the wrapper still parse as plain storageState.
    let storageState: unknown | undefined
    let importedUserAgent: string | undefined
    if (hadState) {
      try {
        const raw = JSON.parse(await Bun.file(stateFile).text()) as {
          userAgent?: string
          storageState?: unknown
          cookies?: unknown
          origins?: unknown
        }
        if (raw.storageState) {
          storageState = raw.storageState
          importedUserAgent = raw.userAgent
        } else {
          storageState = raw
        }
      } catch (e) {
        console.warn(`[browser_play] state file parse failed (${e}), launching fresh`)
      }
    }

    const browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    })

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: storageState as never,
      ...(importedUserAgent ? { userAgent: importedUserAgent } : {}),
    })

    const page = await context.newPage()
    const results: unknown[] = []

    const persistState = async () => {
      try {
        // context.storageState() returns the raw cookies/origins shape.
        // Re-wrap with the importedUserAgent so the field survives the
        // round-trip — otherwise the next browser_play falls back to the
        // pod's Linux Chromium UA and Instagram invalidates the session.
        const fresh = await context.storageState()
        const payload = importedUserAgent
          ? { userAgent: importedUserAgent, storageState: fresh }
          : fresh
        await Bun.write(stateFile, JSON.stringify(payload, null, 2))
      } catch (e) {
        console.warn(`[browser_play] failed to persist state: ${e}`)
      }
    }

    try {
      for (const action of actions) {
        switch (action.kind) {
          case "navigate": {
            await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 })
            results.push({ action: "navigate", url: action.url, title: await page.title() })
            break
          }
          case "click": {
            const el = await page.$(action.selector)
            if (el) {
              await el.click({ timeout: 10000 })
            } else if (action.selector.includes(":has-text(") || action.selector.includes("text=")) {
              await page.click(action.selector, { timeout: 10000 })
            } else {
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
            await new Promise((r) => setTimeout(r, action.ms))
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
                    Authorization: `Bearer ${oauthToken}`,
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
                const visionData = (await visionRes.json()) as { content?: Array<{ type: string; text?: string }> }
                visionDescription = visionData?.content?.find((c) => c.type === "text")?.text
              } catch (_e) {
                // vision failed, continue without it
              }
            }

            const telegramToken = process.env.TELEGRAM_BOT_TOKEN
            const chatId = ctx.from
            if (telegramToken && chatId && chatId !== "cron") {
              const file = Bun.file(outPath)
              const form = new FormData()
              form.append("chat_id", chatId)
              form.append("caption", `📸 ${await page.url()}`)
              form.append(
                "photo",
                new Blob([await file.arrayBuffer()], { type: "image/png" }),
                "screenshot.png",
              )
              const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendPhoto`, {
                method: "POST",
                body: form,
              })
              await Bun.spawn(["rm", "-f", outPath]).exited
              results.push({ action: "screenshot", sent: ((await res.json()) as { ok: boolean }).ok, vision: visionDescription })
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
      await persistState()

      // Heuristic: redirect to /login indicates the profile lost its session.
      // Surface this to the agent so it kicks off the browser_login flow.
      const needsLogin = /\/(login|accounts\/login|signin)(\?|$|\/)/i.test(currentUrl)
      return {
        ok: true,
        profile,
        url: currentUrl,
        title,
        results,
        ...(needsLogin
          ? {
              needsLogin: true,
              hint: `Profile "${profile}" needs authentication. Call browser_login with profile="${profile}" to get a vncUrl, forward it to the user, then call browser_login_done with the same profile to capture cookies.`,
            }
          : {}),
      }
    } catch (err) {
      await persistState()
      return { ok: false, profile, error: String(err), results }
    } finally {
      await browser.close()
    }
  },
}
