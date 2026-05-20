import { z } from "zod"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { harvestStorageState } from "./cookieHarvest"
import { createLogger } from "../../../../../setup/logger"

const log = createLogger("browser_login")

function ranchBase(): string | null {
  const raw = process.env.RANCH_API_URL ?? process.env.API_URL
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

function bridleKey(): string | null {
  return process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY ?? null
}

interface ISessionPayload {
  session: { id: string }
  cdpUrl: string
  vncUrl: string | null
}

async function openPoolSession(
  userId: string,
  accountKey: string,
): Promise<ISessionPayload | { error: string }> {
  const base = ranchBase()
  const key = bridleKey()
  if (!base || !key) return { error: "Browser pool not configured (RANCH_API_URL / BRIDLE_API_KEY missing)" }
  const res = await fetch(`${base}/browser/internal/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridle-api-key": key },
    body: JSON.stringify({ userId, accountKey }),
  }).catch((e) => ({ ok: false, status: 0, text: () => Promise.resolve((e as Error).message) }) as Response)
  if (!res.ok) return { error: `Pool refused session (${res.status})` }
  const body = (await res.json()) as { data?: ISessionPayload } | ISessionPayload
  const data = "data" in body && body.data ? body.data : (body as ISessionPayload)
  if (!data?.session?.id) return { error: "Pool returned malformed payload" }
  return data
}

const localStatePath = (ctx: ToolContext, accountKey: string): string => {
  const safe = accountKey.replace(/[^a-zA-Z0-9_:\-.]/g, "_")
  const userPart = ctx.from && ctx.from !== "cron" && ctx.from !== "heartbeat"
    ? `${ctx.from.replace(/[^a-zA-Z0-9_\-.]/g, "_")}-`
    : ""
  return `${ctx.agentDir}/browser-state/${userPart}${safe}.json`
}

// Stopgap until the human-tasks refactor: browserless v2 spawns Chrome on
// CDP connect and tears it down on disconnect, so a freshly minted VNC URL
// renders against an empty Xvfb until *something* holds an open CDP socket.
// We park a single WebSocket per pool sessionId, navigate it to the agent-
// provided loginUrl, and release it from `browser_login_done` (or after a
// ttl that matches the VNC JWT exp). Lives in a module Map, not in the
// task runtime — a runtime restart drops everything and the agent has to
// re-issue browser_login. Acceptable while this is a stopgap.
interface IHeldCdp {
  ws: WebSocket
  autoCloseTimer: ReturnType<typeof setTimeout>
}
const heldCdpSessions = new Map<string, IHeldCdp>()

async function holdSessionAlive(
  sessionId: string,
  cdpUrl: string,
  url: string,
  ttlMs = 15 * 60 * 1000,
): Promise<void> {
  // If browser_login is called twice for the same session (re-login flow),
  // tear the old hold down first so we don't leak ws or stack timers.
  const prior = heldCdpSessions.get(sessionId)
  if (prior) {
    clearTimeout(prior.autoCloseTimer)
    try { prior.ws.close() } catch {}
    heldCdpSessions.delete(sessionId)
  }

  const ws = new WebSocket(cdpUrl)
  await new Promise<void>((resolve, reject) => {
    const openTimer = setTimeout(
      () => { try { ws.close() } catch {}; reject(new Error("CDP open timeout — pool unreachable")) },
      15_000,
    )
    ws.addEventListener("open", () => {
      clearTimeout(openTimer)
      ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }))
      resolve()
    }, { once: true })
    ws.addEventListener("error", () => {
      clearTimeout(openTimer)
      reject(new Error("CDP open error — pool refused connection"))
    }, { once: true })
  })

  const autoCloseTimer = setTimeout(() => {
    try { ws.close() } catch {}
    heldCdpSessions.delete(sessionId)
  }, ttlMs)

  ws.addEventListener("close", () => {
    clearTimeout(autoCloseTimer)
    heldCdpSessions.delete(sessionId)
  })

  heldCdpSessions.set(sessionId, { ws, autoCloseTimer })
}

function releaseHeldSession(sessionId: string): void {
  const held = heldCdpSessions.get(sessionId)
  if (!held) return
  clearTimeout(held.autoCloseTimer)
  try { held.ws.close() } catch {}
  heldCdpSessions.delete(sessionId)
}

const loginSchema = z.object({
  profile: z
    .string()
    .min(1)
    .describe(
      "Profile / account label, e.g. \"instagram\" or \"instagram:miybot\". Must match the value used in later browser_play and browser_login_done calls.",
    ),
  loginUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Login page URL the user should see when they open the vncUrl, e.g. \"https://www.instagram.com/accounts/login/\". The runtime opens this in the pool's Chrome before returning so the VNC view isn't a blank desktop. Omit only if you genuinely want about:blank.",
    ),
})

export const BrowserLoginTool: Tool = {
  name: "browser_login",
  description: `Open a remote browser session for the user to log in manually. Use this when browser_play returns needsLogin or when a profile has never been authenticated.

Flow:
1. Call browser_login with the same profile name you'll use for browser_play.
2. Forward the returned vncUrl to the user verbatim: "Открой эту ссылку, залогинься в Instagram, потом скажи когда готово: <vncUrl>".
3. Wait for the user to confirm.
4. Call browser_login_done with the same profile — it harvests cookies into the local state file.
5. Now browser_play with that profile is logged in.

Do not ask the user to log in at the real site URL (instagram.com etc.) — the login MUST happen in the pool's browser so cookies end up on the persistent profile.`,
  schema: loginSchema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { profile, loginUrl } = loginSchema.parse(params)
    const userId = ctx.from && ctx.from !== "cron" && ctx.from !== "heartbeat" ? ctx.from : ""
    if (!userId) return { ok: false, error: "browser_login requires a user context (ctx.from)" }

    const sessionRes = await openPoolSession(userId, profile)
    if ("error" in sessionRes) return { ok: false, error: sessionRes.error }

    let warm: "ok" | "failed" = "ok"
    try {
      await holdSessionAlive(sessionRes.session.id, sessionRes.cdpUrl, loginUrl ?? "about:blank")
    } catch (err) {
      // Non-fatal: the VNC URL still works, just lands on a blank Xvfb.
      // Surface the reason so the agent can decide whether to retry.
      log.error(`warm CDP failed for ${sessionRes.session.id}`, (err as Error).message)
      warm = "failed"
    }

    return {
      ok: true,
      profile,
      sessionId: sessionRes.session.id,
      vncUrl: sessionRes.vncUrl,
      warmedChrome: warm === "ok",
      message:
        warm === "ok"
          ? "Forward vncUrl to the user. Once they say they're done, call browser_login_done with the same profile."
          : "Pool session ready but Chrome could not be pre-warmed; the VNC view may render blank until the user types a URL. Forward vncUrl and proceed to browser_login_done as normal.",
    }
  },
}

const loginDoneSchema = z.object({
  profile: z.string().min(1).describe("Same profile name passed to browser_login."),
})

export const BrowserLoginDoneTool: Tool = {
  name: "browser_login_done",
  description: `Finalize a browser login: extract cookies from the pool session into the local profile state file. Call this AFTER the user has confirmed they finished signing in via the vncUrl returned by browser_login.

After this returns ok, subsequent browser_play calls with the same profile reuse the captured cookies and run locally — no more VNC needed unless cookies expire.`,
  schema: loginDoneSchema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { profile } = loginDoneSchema.parse(params)
    const userId = ctx.from && ctx.from !== "cron" && ctx.from !== "heartbeat" ? ctx.from : ""
    if (!userId) return { ok: false, error: "browser_login_done requires a user context (ctx.from)" }

    // Look up the existing session — we need its id to ask ranch-api to
    // run harvest over the WARM CDP socket. Opening our own WS would
    // spawn a parallel Chrome trying to claim the same --user-data-dir,
    // and Chrome refuses to start with a locked profile.
    const sessionRes = await openPoolSession(userId, profile)
    if ("error" in sessionRes) return { ok: false, error: sessionRes.error }

    const base = ranchBase()
    const key = bridleKey()
    if (!base || !key) return { ok: false, error: "RANCH_API_URL / BRIDLE_API_KEY missing" }

    const harvest = await fetch(
      `${base}/browser/internal/sessions/${sessionRes.session.id}/harvest`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridle-api-key": key },
        body: JSON.stringify({ userId }),
      },
    ).catch((e) => ({ ok: false, status: 0, text: () => Promise.resolve((e as Error).message) }) as Response)

    if (!harvest.ok) {
      releaseHeldSession(sessionRes.session.id)
      return {
        ok: false,
        sessionId: sessionRes.session.id,
        error: `Harvest request failed (${harvest.status}): ${(await harvest.text()).slice(0, 300)}`,
      }
    }
    const body = (await harvest.json()) as { data?: { cookies: unknown[]; origins: unknown[] } } | { cookies: unknown[]; origins: unknown[] }
    const state = ("data" in body && body.data ? body.data : body) as { cookies: unknown[]; origins: unknown[] }

    // Release the local hold (if any was set up in this runtime via
    // browser_login). The API's warm hold continues to keep Chrome alive
    // until the warm TTL expires — we're not done with the session yet,
    // browser_play might still want to inspect things.
    releaseHeldSession(sessionRes.session.id)

    if (state.cookies.length === 0) {
      return {
        ok: false,
        sessionId: sessionRes.session.id,
        error:
          "Chrome reported zero cookies. The user probably didn't complete the login — re-open the vncUrl and finish signing in before calling this again.",
      }
    }

    const path = localStatePath(ctx, profile)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2))

    // Tell ranch-api the profile is now authenticated so the admin UI badge
    // flips from "Needs login" back to "Idle". Failure is non-fatal — the
    // cookies are saved either way.
    await fetch(`${base}/browser/internal/sessions/${sessionRes.session.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridle-api-key": key },
      body: JSON.stringify({ userId, status: "idle" }),
    }).catch(() => {})

    return {
      ok: true,
      profile,
      sessionId: sessionRes.session.id,
      cookies: state.cookies.length,
      stateFile: path.startsWith(ctx.agentDir) ? path.slice(ctx.agentDir.length + 1) : path,
      message: `Saved ${state.cookies.length} cookies. browser_play with profile="${profile}" will now run logged in.`,
    }
  },
}

// Helper kept exported so playwright.repository can use the same path when
// it restores state — single source of truth for "where the JSON lives".
export const profileStatePath = localStatePath
