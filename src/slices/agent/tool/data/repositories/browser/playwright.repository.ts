import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { mkdirSync, existsSync } from "fs"
import { dirname } from "path"
import { ensurePlaywright, chromiumPath } from "./ensure-playwright"

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

interface SessionRef {
  id: string
  cdpUrl: string
  vncUrl: string | null
}

// Resolve the browser-pool session for this (userId, profile). Returns null
// when no pool is configured — that's the dev/CLI path where we still want
// `browser_play` to work via a local Chromium binary.
async function openPoolSession(
  userId: string,
  accountKey: string,
): Promise<SessionRef | null> {
  const apiUrl = process.env.RANCH_API_URL ?? process.env.API_URL
  const apiKey = process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY
  if (!apiUrl || !apiKey) return null
  try {
    const res = await fetch(`${apiUrl}/browser/internal/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridle-api-key": apiKey,
      },
      body: JSON.stringify({ userId, accountKey }),
    })
    if (!res.ok) {
      console.warn(`[browser_play] pool refused session (${res.status}) — falling back to local`)
      return null
    }
    const data = (await res.json()) as {
      session: { id: string }
      cdpUrl: string
      vncUrl: string | null
    }
    return { id: data.session.id, cdpUrl: data.cdpUrl, vncUrl: data.vncUrl }
  } catch (err) {
    console.warn(`[browser_play] pool unreachable (${(err as Error).message}) — falling back to local`)
    return null
  }
}

async function reportSessionStatus(
  userId: string,
  sessionId: string,
  status: "idle" | "needs_login" | "stuck",
): Promise<void> {
  const apiUrl = process.env.RANCH_API_URL ?? process.env.API_URL
  const apiKey = process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY
  if (!apiUrl || !apiKey) return
  try {
    await fetch(`${apiUrl}/browser/internal/sessions/${sessionId}/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridle-api-key": apiKey,
      },
      body: JSON.stringify({ userId, status }),
    })
  } catch (err) {
    console.warn(`[browser_play] failed to report status: ${(err as Error).message}`)
  }
}

export const PlaywrightTool: Tool = {
  name: "browser_play",
  description: `Full Playwright browser control with persistent sessions (cookies, localStorage saved between calls and across container restarts).
Use this to: log into websites, automate web tasks, scrape authenticated pages, interact with web apps.
Supports: navigate, click, fill, press, wait, waitForSelector, evaluate (JS), screenshot, getText.
Each 'profile' has its own persistent session — login once, reuse forever.
When this tool returns { needsLogin: true, vncUrl }, surface the vncUrl to the user (e.g. via Telegram) and ask them to finish the login manually before retrying.
Example: log in to Instagram with profile="instagram", then future calls with same profile stay logged in.`,
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { profile, actions } = schema.parse(params)

    const home = process.env.HOME ?? "/tmp"

    // ctx.from is the chat user id (e.g. Telegram userId) — already isolated
    // by the runtime, never trusted as raw input from the LLM. We forward it
    // to ranch-api which builds the profile path /profiles/<userId>/<profile>
    // on the shared pool PVC.
    const userId = ctx.from && ctx.from !== "cron" && ctx.from !== "heartbeat" ? ctx.from : ""
    const session = userId ? await openPoolSession(userId, profile) : null

    const { chromium } = await ensurePlaywright()

    let browser: import("playwright").Browser
    let context: import("playwright").BrowserContext
    let isPooled = false
    let localStateFile: string | null = null

    if (session) {
      // Pool path — the profile lives on the pool PVC, no local state file.
      // Chrome inside the pool persists cookies to --user-data-dir, so
      // re-connecting next time picks up where we left off automatically.
      //
      // We use `chromium.connect()` (Playwright WS protocol), NOT
      // `connectOverCDP()` — the latter ignores the `launch` query param
      // that carries our per-tenant --user-data-dir.
      isPooled = true
      browser = await chromium.connect(session.cdpUrl)
      const existingContexts = browser.contexts()
      context = existingContexts[0] ?? (await browser.newContext({
        viewport: { width: 1280, height: 900 },
      }))
    } else {
      // Local path (dev / CLI / no pool configured). Persist cookies to a
      // JSON file under .agent/ so it ships to S3 via S3SyncService.
      const safeUserId = userId.replace(/[^a-zA-Z0-9_\-.]/g, "_")
      const isolatedProfile = userId ? `${safeUserId}-${profile}` : profile
      localStateFile = `${ctx.agentDir}/browser-state/${isolatedProfile}.json`
      mkdirSync(dirname(localStateFile), { recursive: true })
      console.log(`[browser_play] local fallback profile=${isolatedProfile} state=${localStateFile} exists=${existsSync(localStateFile)}`)
      browser = await chromium.launch({
        headless: true,
        executablePath: chromiumPath(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      })
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        storageState: existsSync(localStateFile) ? localStateFile : undefined,
      })
    }

    const page = context.pages()[0] ?? (await context.newPage())
    const results: unknown[] = []

    const persistLocalState = async () => {
      if (!localStateFile) return
      try { await context.storageState({ path: localStateFile }) }
      catch (e) { console.warn(`[browser_play] failed to persist state: ${e}`) }
    }

    const close = async () => {
      try {
        if (isPooled) {
          // Pooled — disconnect, browser stays alive in the pool for the
          // next call. Don't close the browser object itself.
          await browser.close().catch(() => {})
        } else {
          await browser.close()
        }
      } catch (e) {
        console.warn(`[browser_play] close failed: ${e}`)
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

            const telegramToken = process.env.TELEGRAM_BOT_TOKEN
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
      await persistLocalState()

      // Heuristic: a redirect to a /login or /accounts/login path during the
      // action sequence means the profile lost its session — flag it so the
      // admin UI surfaces "needs_login" and the agent forwards vncUrl.
      const needsLogin = /\/(login|accounts\/login|signin)(\?|$|\/)/i.test(currentUrl)
      if (session) {
        await reportSessionStatus(userId, session.id, needsLogin ? "needs_login" : "idle")
      }

      return {
        ok: true,
        profile,
        url: currentUrl,
        title,
        results,
        ...(needsLogin && session
          ? { needsLogin: true, vncUrl: session.vncUrl, sessionId: session.id }
          : {}),
      }
    } catch (err) {
      await persistLocalState()
      if (session) {
        await reportSessionStatus(userId, session.id, "stuck")
      }
      return {
        ok: false,
        profile,
        error: String(err),
        results,
        ...(session ? { vncUrl: session.vncUrl, sessionId: session.id } : {}),
      }
    } finally {
      await close()
    }
  },
}
