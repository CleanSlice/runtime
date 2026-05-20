import { z } from "zod"
import type { Tool } from "../../../domain/tool.types"

// Resolves the user's integration secrets lazily — one HTTP call per
// invocation, so rotated keys are picked up without restarting the agent.
// Mirrors the (RANCH_API_URL, BRIDLE_API_KEY) env-var pair used by every
// other ranch-internal tool — see browserLogin.repository.ts.
function ranchBase(): string | null {
  const raw = process.env.RANCH_API_URL ?? process.env.API_URL
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

function bridleKey(): string | null {
  return process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY ?? null
}

interface IResolvedSecrets {
  env: Record<string, string>
}

const schema = z.object({
  service: z
    .string()
    .optional()
    .describe(
      "Restrict to one catalogue service (e.g. 'openai', 'github', 'stripe'). Omit to fetch every connected secret-mechanism integration the calling user has.",
    ),
})

export const IntegrationSecretsTool: Tool = {
  name: "integration_secrets",
  description: `Resolve the connected secret-mechanism integrations into a flat env map. Called whenever the agent needs an API key managed from the /sessions admin UI — OpenAI, GitHub, Stripe, etc.

Returns { env: { ENV_NAME: "value", … } }. Empty object if there is no matching connected integration — in that case, ask the user to open /sessions and connect the service.

Multiple accounts on the same service: the most recently updated one wins the bare env var (e.g. GITHUB_TOKEN); each account is also exposed under a per-accountKey alias (GITHUB_TOKEN_PERSONAL, GITHUB_TOKEN_WORK). Always pick aliases over the bare name when the workflow targets a specific identity.

Resolves at tool-call time — no restart needed after key rotation. Treat the returned values like any secret: never echo them in chat, never log requests with the Authorization header intact.`,
  schema,
  async execute(params: unknown): Promise<unknown> {
    const { service } = schema.parse(params)

    const base = ranchBase()
    const key = bridleKey()
    if (!base || !key) {
      return {
        env: {},
        error:
          "Ranch API not configured (RANCH_API_URL / BRIDLE_API_KEY missing). Set them in the runtime env to enable integration secret resolution.",
      }
    }

    const url = new URL(`${base}/integrations/internal/secrets`)
    if (service) url.searchParams.set("service", service)

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-bridle-api-key": key },
    })
    if (!res.ok) {
      return {
        env: {},
        error: `Ranch API returned ${res.status} ${res.statusText}`,
      }
    }

    const body = (await res.json()) as
      | IResolvedSecrets
      | { data: IResolvedSecrets }
    const payload = "data" in body ? body.data : body
    return { env: payload?.env ?? {} }
  },
}
