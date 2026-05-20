import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"
import { mkdirSync, existsSync } from "fs"
import { dirname } from "path"
import { ensurePlaywright, chromiumPath } from "./ensure-playwright"
import { profileStatePath } from "./browserLogin.repository"

// playwright-extra wraps Playwright and lets us register puppeteer-style
// plugins. The stealth plugin patches a long list of fingerprint
// surfaces — navigator.webdriver, plugins[], permissions API, chrome
// runtime, WebGL vendor, screen, etc. — that Instagram / Meta / Cloudflare
// check before serving a logged-in response. Without this, even with
// matching cookies + UA, Instagram drops the session and renders the
// logged-out landing page.
import { chromium as chromiumExtra } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"

let stealthRegistered = false
function ensureStealth() {
  if (stealthRegistered) return
  chromiumExtra.use(StealthPlugin())
  stealthRegistered = true
}

/**
 * Fetch the user-level imported storageState from ranch-api as a fallback
 * when no per-agent file exists. Mirrors the (RANCH_API_URL, BRIDLE_API_KEY)
 * env-var pair used by every other ranch-internal tool. Returns null on
 * any error (network, 404, misconfig) — the caller proceeds without state.
 */
async function tryFetchUserBrowserState(
  userId: string | undefined,
  profile: string,
): Promise<unknown | null> {
  if (!userId) return null
  const base = (process.env.RANCH_API_URL ?? process.env.API_URL)?.replace(/\/+$/, "")
  const key = process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY
  if (!base || !key) return null
  try {
    const url = new URL(`${base}/integrations/internal/browser-state`)
    url.searchParams.set("userId", userId)
    url.searchParams.set("profile", profile)
    const res = await fetch(url.toString(), {
      headers: { "x-bridle-api-key": key },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: unknown }
    return body?.data ?? body
  } catch {
    return null
  }
}

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

    // Kill any Chromium left over from a previous run. The runtime's 120s
    // tool timeout abandons the execute() promise WITHOUT running our
    // finally block, so a timed-out browser_play leaves its Chromium (and
    // ~6 child processes) alive. Across a few retries the pod accumulates
    // dozens of zombies, starves CPU/RAM, and every fresh launch then
    // also times out — a self-reinforcing storm. Agents run tools
    // sequentially, so nothing legitimate is running here to kill.
    try {
      await Bun.spawn(["pkill", "-9", "-f", "chromium"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    } catch {
      // pkill missing or nothing to kill — fine either way
    }

    const stateFile = profileStatePath(ctx, profile)
    mkdirSync(dirname(stateFile), { recursive: true })
    let hadState = existsSync(stateFile)

    // Fallback to the per-user import store when no agent-local state
    // exists yet. Lets `/integrations/accounts/:id/import-cookies` cover
    // every agent the user owns with a single paste — agent picks it up
    // on its next browser_play, writes locally, future runs use the
    // cached file (same path the extension's harvest flow writes to).
    if (!hadState) {
      const fetched = await tryFetchUserBrowserState(ctx.from, profile)
      if (fetched) {
        try {
          await Bun.write(stateFile, JSON.stringify(fetched, null, 2))
          hadState = true
          console.log(`[browser_play] hydrated ${stateFile} from /integrations/internal/browser-state`)
        } catch (e) {
          console.warn(`[browser_play] failed to write hydrated state: ${e}`)
        }
      }
    }

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

    // playwright-extra exposes the same `chromium.launch` signature as
    // playwright proper; once StealthPlugin is registered, every launch
    // (including this one) gets the stealth init script applied to every
    // new page. We keep the same executablePath / args so the container
    // chromium binary is still used.
    ensureStealth()
    const browser = await chromiumExtra.launch({
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

    // Self-imposed deadline below the runtime's 120s tool budget. When it
    // fires we force-close the browser; in-flight page operations then
    // reject with "Target closed", the catch block runs, and the finally
    // block's browser.close() is reached — instead of the runtime
    // abandoning us at 120s and leaking the whole process tree.
    let deadlineHit = false
    const watchdog = setTimeout(() => {
      deadlineHit = true
      console.warn("[browser_play] internal 100s deadline — force-closing browser")
      browser.close().catch(() => {})
    }, 100_000)

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
      // The fix is the integration_request_login tool — no VNC anymore.
      const needsLogin = /\/(login|accounts\/login|signin|i\/flow\/login)(\?|$|\/)/i.test(currentUrl)
      const [service, accountKey] = profile.includes(":")
        ? [profile.slice(0, profile.indexOf(":")), profile.slice(profile.indexOf(":") + 1)]
        : [profile, "default"]
      return {
        ok: true,
        profile,
        url: currentUrl,
        title,
        results,
        ...(needsLogin
          ? {
              needsLogin: true,
              hint: `Profile "${profile}" is not logged in. Call integration_request_login with service="${service}" and accountKey="${accountKey}", forward the returned instructions to the user, then STOP and wait for them to confirm before retrying. Do NOT loop browser_play.`,
            }
          : {}),
      }
    } catch (err) {
      await persistState()
      const msg = deadlineHit
        ? `browser_play hit its internal 100s deadline — the page or a selector stalled. Do NOT immediately retry; if this persists the site is slow or the selector is wrong.`
        : String(err)
      return { ok: false, profile, error: msg, results }
    } finally {
      clearTimeout(watchdog)
      await browser.close().catch(() => {})
    }
  },
}
