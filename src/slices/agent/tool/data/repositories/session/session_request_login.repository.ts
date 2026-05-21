import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { SessionModule } from "../../../../../setup/session/session.module"

// Asks the host for human-readable login instructions + a link, which
// the agent forwards to the end user. The user logs in to the service
// in their own browser and gets cookies to the host out-of-band. All
// host specifics live behind SessionModule's adapter.

let _sessions: SessionModule | null = null
function getSessions(ctx: ToolContext): SessionModule {
  if (!_sessions) _sessions = new SessionModule(ctx.agentDir)
  return _sessions
}

const schema = z.object({
  service: z
    .string()
    .min(1)
    .describe(
      "Catalogue service key — same as the prefix of the browser_play profile. For `profile: \"x:dimzhuk\"` pass `service: \"x\"`.",
    ),
  accountKey: z
    .string()
    .min(1)
    .describe(
      "Account label for this session — same as the suffix of the browser_play profile. For `profile: \"x:dimzhuk\"` pass `accountKey: \"dimzhuk\"`.",
    ),
})

export const SessionRequestLoginTool: Tool = {
  name: "session_request_login",
  description: `Ask the host for login instructions when a browser-mechanism session is missing cookies or has expired.

Returns { helpUrl, siteUrl, instructions }. Forward this to the end user verbatim — do NOT paraphrase the URLs:

  • helpUrl — page that walks the user through getting cookies to the host. Open in any browser.
  • siteUrl — direct link to the service login page (the user opens this in their normal browser and logs in).
  • instructions — short lines safe to paste into chat as-is.

Cookies arrive out-of-band — the user follows the returned instructions. Once they land, the session status flips to "connected" and subsequent browser_play calls work.

After forwarding, STOP and wait for the user to confirm they sent cookies. Do not retry browser_play in a tight loop — give the user time. When they say they're done, retry the original tool call.`,
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { service, accountKey } = schema.parse(params)
    try {
      const instr = await getSessions(ctx).requestLogin(service, accountKey)
      if (!instr) {
        return {
          error: `No login instructions available for "${service}:${accountKey}".`,
        }
      }
      return instr
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
}
