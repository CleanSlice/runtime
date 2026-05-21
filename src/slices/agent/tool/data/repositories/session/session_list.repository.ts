import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { SessionModule } from "../../../../../setup/session/session.module"

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
  description: `List the external services connected to this agent (Instagram, X, GitHub, etc.).

Call this BEFORE browser_play whenever you need to act on a social account but don't already know the exact profile. Returns:

  { accounts: [ { service, accountKey, profile, mechanism, status } ] }

Use the \`profile\` field VERBATIM as the browser_play \`profile\` argument — never guess "default" or a bare service name. Example: an account { service: "x", accountKey: "dimzhuk" } means call browser_play with profile: "x:dimzhuk".

mechanism "browser" → drive it with browser_play. mechanism "secret" → its API key is available via session_secrets, no browser needed.
status "connected" → ready to use. status "needs_login"/"pending" → call session_request_login and forward the instructions to the user first.

If accounts is empty, nothing is connected — tell the user to connect a session in the host's admin UI (the /sessions page).`,
  schema,
  async execute(_params: unknown, ctx: ToolContext): Promise<unknown> {
    try {
      const accounts = await getSessions(ctx).list()
      return { accounts }
    } catch (err) {
      return {
        accounts: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },
}
