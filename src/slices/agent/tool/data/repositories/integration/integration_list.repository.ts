import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

// Lets an agent discover which integrations the calling user has
// connected — so browser_play gets the exact profile string
// (`<service>:<accountKey>`, e.g. "x:dimzhuk") instead of the agent
// guessing "default" or "x" and hitting needsLogin.

function ranchBase(): string | null {
  const raw = process.env.RANCH_API_URL ?? process.env.API_URL
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

function bridleKey(): string | null {
  return process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY ?? null
}

interface IRuntimeAccount {
  service: string
  accountKey: string
  profile: string
  mechanism: "browser" | "secret"
  status: string
  aliases: string[]
}

const schema = z.object({})

export const IntegrationListTool: Tool = {
  name: "integration_list",
  description: `List the external services the calling user has connected (Instagram, X, GitHub, etc.).

Call this BEFORE browser_play whenever you need to act on a social account but don't already know the exact profile. Returns:

  { accounts: [ { service, accountKey, profile, mechanism, status } ] }

Use the \`profile\` field VERBATIM as the browser_play \`profile\` argument — never guess "default" or a bare service name. Example: an account { service: "x", accountKey: "dimzhuk" } means call browser_play with profile: "x:dimzhuk".

mechanism "browser" → drive it with browser_play. mechanism "secret" → its API key is available via integration_secrets, no browser needed.
status "connected" → ready to use. status "needs_login"/"pending" → call integration_request_login and forward the instructions to the user first.

If accounts is empty, the user hasn't connected anything — tell them to open /integrations in the admin UI.`,
  schema,
  async execute(_params: unknown, ctx: ToolContext): Promise<unknown> {
    const userId = ctx.from
    if (!userId) {
      return {
        accounts: [],
        error:
          "ctx.from is empty — integration_list needs an authenticated chat session.",
      }
    }
    const base = ranchBase()
    const key = bridleKey()
    if (!base || !key) {
      return {
        accounts: [],
        error:
          "Ranch API not configured (RANCH_API_URL / BRIDLE_API_KEY missing).",
      }
    }

    const url = new URL(`${base}/integrations/internal/accounts`)
    url.searchParams.set("userId", userId)
    const res = await fetch(url.toString(), {
      headers: { "x-bridle-api-key": key },
    })
    if (!res.ok) {
      return {
        accounts: [],
        error: `Ranch API returned ${res.status} ${res.statusText}`,
      }
    }
    const body = (await res.json()) as
      | { accounts: IRuntimeAccount[] }
      | { data: { accounts: IRuntimeAccount[] } }
    const payload = "data" in body ? body.data : body
    return { accounts: payload?.accounts ?? [] }
  },
}
