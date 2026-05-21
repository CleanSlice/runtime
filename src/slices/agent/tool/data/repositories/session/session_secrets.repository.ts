import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { SessionModule } from "../../../../../setup/session/session.module"

// Resolves secret-mechanism sessions into a flat env map — one call per
// invocation, so rotated keys are picked up without restarting the
// agent. All host knowledge lives behind SessionModule's adapter.

let _sessions: SessionModule | null = null
function getSessions(ctx: ToolContext): SessionModule {
  if (!_sessions) _sessions = new SessionModule(ctx.agentDir)
  return _sessions
}

const schema = z.object({
  service: z
    .string()
    .optional()
    .describe(
      "Restrict to one catalogue service (e.g. 'openai', 'github', 'stripe'). Omit to fetch every connected secret-mechanism session.",
    ),
})

export const SessionSecretsTool: Tool = {
  name: "session_secrets",
  description: `Resolve the connected secret-mechanism sessions into a flat env map. Called whenever the agent needs an API key the user connected — OpenAI, GitHub, Stripe, etc.

Returns { env: { ENV_NAME: "value", … } }. Empty object if there is no matching connected session — in that case, ask the user to open the /sessions admin page and connect the service.

Multiple accounts on the same service: the most recently updated one wins the bare env var (e.g. GITHUB_TOKEN); each account may also be exposed under a per-accountKey alias (GITHUB_TOKEN_PERSONAL, GITHUB_TOKEN_WORK). Always pick aliases over the bare name when the workflow targets a specific identity.

Resolves at tool-call time — no restart needed after key rotation. Treat the returned values like any secret: never echo them in chat, never log requests with the Authorization header intact.`,
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { service } = schema.parse(params)
    try {
      const env = await getSessions(ctx).resolveSecrets(service)
      return { env }
    } catch (err) {
      return {
        env: {},
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },
}
