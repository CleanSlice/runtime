import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { SessionModule } from "../../../../../setup/session/session.module"
import { savedProfiles } from "../browser/browserLogin.repository"
import type { IRuntimeSession } from "../../../../../setup/session/domain/session.types"

/** A session the person shared with this agent from their own browser (CLEAN-243). */
interface ISharedProfile {
  profile: string
  mechanism: "browser"
  status: "connected"
  source: "shared"
}

// Lets an agent discover which sessions are connected — so browser_play
// gets the exact profile string (`<service>:<accountKey>`, e.g. "x:dimzhuk")
// instead of the agent guessing "default" or "x" and hitting needsLogin.
//
// All host knowledge lives in SessionModule's adapter — this tool is a
// thin shell over the ISessionGateway port.

let _sessions: SessionModule | null = null
function getSessions(ctx: ToolContext): SessionModule {
  if (!_sessions) _sessions = new SessionModule(ctx.agentDir)
  return _sessions
}

const schema = z.object({})

export const SessionListTool: Tool = {
  name: "session_list",

  effect: "read",
  description: `List the external services connected to this agent (Instagram, X, GitHub, etc.).

Call this BEFORE browser_play whenever you need to act on a social account but don't already know the exact profile. Returns:

  { accounts: [ { service, accountKey, profile, mechanism, status } ] }

Use the \`profile\` field VERBATIM as the browser_play \`profile\` argument — never guess "default" or a bare service name. Example: an account { service: "x", accountKey: "dimzhuk" } means call browser_play with profile: "x:dimzhuk".

mechanism "browser" → drive it with browser_play. mechanism "secret" → its API key is available via session_secrets, no browser needed.
status "connected" → ready to use. status "needs_login"/"pending" → call session_request_login and forward the instructions to the user first.

Accounts with source "shared" are browser sessions this person handed to this agent from their own browser (the Ranch Cookies extension) — e.g. { profile: "shadow", site cookies for a site that is not an integration }. They are ready: call browser_play with that profile straight away. Never call session_request_login for them and never tell the person to "create an integration" — if the site still shows its login page, the shared session has expired, so ask the person to sign in to the site in their browser and send it again with the extension.

If accounts is empty, nothing is connected — tell the user to connect a session in the host's admin UI (the /sessions page), or to share the site's session from their browser with the Ranch Cookies extension.`,
  schema,
  async execute(_params: unknown, ctx: ToolContext): Promise<unknown> {
    try {
      const accounts: Array<IRuntimeSession | ISharedProfile> = await getSessions(ctx).list()
      // What this person shared with this agent from their own browser
      // (CLEAN-243). The integration list above does not know these, and an
      // agent told "no such profile" sent people off to create integrations
      // for sessions it already had.
      const known = new Set(accounts.map((a) => a.profile))
      for (const profile of savedProfiles(ctx)) {
        if (known.has(profile)) continue
        accounts.push({ profile, mechanism: "browser", status: "connected", source: "shared" })
      }
      return { accounts }
    } catch (err) {
      return {
        accounts: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },
}
