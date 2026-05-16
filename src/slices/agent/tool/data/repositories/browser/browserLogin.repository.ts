import { z } from "zod"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { harvestStorageState } from "./cookieHarvest"

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

const loginSchema = z.object({
  profile: z
    .string()
    .min(1)
    .describe(
      "Profile / account label, e.g. \"instagram\" or \"instagram:miybot\". Must match the value used in later browser_play and browser_login_done calls.",
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
    const { profile } = loginSchema.parse(params)
    const userId = ctx.from && ctx.from !== "cron" && ctx.from !== "heartbeat" ? ctx.from : ""
    if (!userId) return { ok: false, error: "browser_login requires a user context (ctx.from)" }

    const sessionRes = await openPoolSession(userId, profile)
    if ("error" in sessionRes) return { ok: false, error: sessionRes.error }

    return {
      ok: true,
      profile,
      sessionId: sessionRes.session.id,
      vncUrl: sessionRes.vncUrl,
      message:
        "Forward vncUrl to the user. Once they say they're done, call browser_login_done with the same profile.",
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

    // Re-open the pool session to get a fresh CDP URL pointing at a Chrome
    // started with the same --user-data-dir. Chrome reads the on-disk cookie
    // store on launch, so the cookies the user just persisted via VNC are
    // already loaded.
    const sessionRes = await openPoolSession(userId, profile)
    if ("error" in sessionRes) return { ok: false, error: sessionRes.error }

    let state: Awaited<ReturnType<typeof harvestStorageState>>
    try {
      state = await harvestStorageState(sessionRes.cdpUrl)
    } catch (err) {
      return {
        ok: false,
        sessionId: sessionRes.session.id,
        error: `Cookie harvest failed: ${(err as Error).message}`,
      }
    }

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
    const base = ranchBase()
    const key = bridleKey()
    if (base && key) {
      await fetch(`${base}/browser/internal/sessions/${sessionRes.session.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridle-api-key": key },
        body: JSON.stringify({ userId, status: "idle" }),
      }).catch(() => {})
    }

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
