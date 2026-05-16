/**
 * Cookie harvest — extract a Playwright-compatible `storageState` from a
 * browserless pool session that was already used for an interactive VNC
 * login.
 *
 * Why: the pool runs browserless v2, which (a) can launch Chrome with a
 * persistent `--user-data-dir` over the `/chromium` (CDP) route but
 * (b) Playwright's `connectOverCDP` can't drive that route end-to-end.
 * Instead of trying to bend Playwright to the pool, we keep Playwright
 * local and treat the pool purely as a place where a human logs in.
 * After login, we connect raw CDP, ask the browser for its cookies +
 * localStorage, and stash them as `storageState` JSON — the same format
 * Playwright reads via `chromium.launch({ storageState: <path> })`.
 *
 * The pool side: every reconnect with `--user-data-dir=/profiles/<u>/<p>`
 * fires a fresh Chrome that reads the on-disk profile (cookies SQLite).
 * Network.getAllCookies returns them all, including HttpOnly ones the
 * page-side `document.cookie` API would never expose.
 */

interface IPlaywrightStorageState {
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: "Strict" | "Lax" | "None"
  }>
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

interface ICdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

interface ICdpResponse {
  id: number
  result?: { cookies?: ICdpCookie[] }
  error?: { message: string }
}

/**
 * Open a raw CDP WebSocket to a browserless `/chromium` session, send a
 * single Network.getAllCookies frame, and return the cookies translated
 * to Playwright's storageState shape.
 *
 * localStorage is intentionally not extracted here — it lives per-origin
 * inside the renderer process and pulling it cleanly would require
 * spinning up a Target.attachToTarget round-trip for every origin the
 * user touched. For login flows (Instagram, Meta Ads, PayPal) cookies
 * are the only thing that matter for auth; localStorage is mostly UX
 * state and gets re-created on next visit.
 */
export async function harvestStorageState(
  cdpUrl: string,
  timeoutMs = 25_000,
): Promise<IPlaywrightStorageState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cdpUrl)
    const cleanup = (cb: () => void) => {
      try { ws.close() } catch {}
      cb()
    }

    const fail = (err: Error) => cleanup(() => reject(err))
    const done = (state: IPlaywrightStorageState) => cleanup(() => resolve(state))

    const timer = setTimeout(
      () => fail(new Error(`Cookie harvest timeout after ${timeoutMs}ms`)),
      timeoutMs,
    )

    ws.addEventListener("open", () => {
      // Network.getAllCookies is session-scoped (needs an attached Target).
      // Storage.getCookies works at the Browser level and returns every
      // cookie from the default browser context — exactly what we want
      // after a VNC login, since the user may have navigated anywhere.
      ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }))
    })

    ws.addEventListener("message", (event) => {
      let msg: ICdpResponse
      try {
        msg = JSON.parse(event.data as string)
      } catch (err) {
        clearTimeout(timer)
        return fail(new Error(`Malformed CDP frame: ${(err as Error).message}`))
      }
      if (msg.id !== 1) return // ignore Network.* event frames
      clearTimeout(timer)
      if (msg.error) return fail(new Error(`CDP error: ${msg.error.message}`))
      const cookies = msg.result?.cookies ?? []
      done({
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          // CDP returns -1 for session cookies; Playwright wants -1 too,
          // so just pass through.
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite ?? "Lax",
        })),
        origins: [],
      })
    })

    ws.addEventListener("error", (event) => {
      clearTimeout(timer)
      fail(new Error(`CDP WS error: ${(event as ErrorEvent).message ?? "unknown"}`))
    })

    ws.addEventListener("close", (event) => {
      clearTimeout(timer)
      const code = (event as CloseEvent).code
      // Resolved normally above already; this only fires when the server
      // dropped us before we got our reply.
      if (code !== 1000) fail(new Error(`CDP WS closed unexpectedly: ${code}`))
    })
  })
}
