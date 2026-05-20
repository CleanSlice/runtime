import { z } from "zod"
import type { Tool } from "../../../domain/tool.types"

// Replaces the legacy browser_login flow which used noVNC + the browser
// pool. Now the agent asks Ranch for human-readable instructions + a
// link, and forwards that to the end user. The user logs in to the
// service in their own Chrome and pushes cookies via the Ranch Cookies
// extension. Same (RANCH_API_URL, BRIDLE_API_KEY) env-var pair as the
// rest of the ranch-internal tools.

function ranchBase(): string | null {
  const raw = process.env.RANCH_API_URL ?? process.env.API_URL
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

function bridleKey(): string | null {
  return process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY ?? null
}

interface ILoginInstruction {
  accountId: string
  siteUrl: string
  helpUrl: string
  instructions: string
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
      "Account label for this integration — same as the suffix of the browser_play profile. For `profile: \"x:dimzhuk\"` pass `accountKey: \"dimzhuk\"`.",
    ),
})

export const IntegrationRequestLoginTool: Tool = {
  name: "integration_request_login",
  description: `Ask Ranch for login instructions when a browser-mechanism integration is missing cookies or has expired.

Returns { helpUrl, siteUrl, instructions }. Forward this to the end user verbatim — do NOT paraphrase the URLs:

  • helpUrl — admin page walking the user through extension install + sending cookies. Open in any browser.
  • siteUrl — direct link to the service login page (the user opens this in their normal Chrome and logs in).
  • instructions — three short lines safe to paste into chat as-is.

Cookies arrive in Ranch via the user's own browser (Ranch Cookies extension). No VNC, no shared browser pool. Once cookies land, the IntegrationAccount status flips to "connected" and subsequent browser_play calls work.

After forwarding, STOP and wait for the user to confirm they pushed cookies. Do not retry browser_play in a tight loop — give the user time. When they say they're done, retry the original tool call.`,
  schema,
  async execute(params: unknown): Promise<unknown> {
    const { service, accountKey } = schema.parse(params)

    const base = ranchBase()
    const key = bridleKey()
    if (!base || !key) {
      return {
        error:
          "Ranch API not configured (RANCH_API_URL / BRIDLE_API_KEY missing in runtime env).",
      }
    }

    const res = await fetch(`${base}/integrations/internal/request-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridle-api-key": key,
      },
      body: JSON.stringify({ service, accountKey }),
    })
    if (!res.ok) {
      return {
        error: `Ranch API returned ${res.status} ${res.statusText}`,
      }
    }
    const body = (await res.json()) as
      | ILoginInstruction
      | { data: ILoginInstruction }
    const payload = "data" in body ? body.data : body
    return payload
  },
}
