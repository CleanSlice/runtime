import type {
  ISessionGateway,
  IRuntimeSession,
  ILoginInstruction,
} from "../../../domain/session.types"

// Ranch host adapter. ALL knowledge of the Ranch API — its endpoint
// paths, its `x-bridle-api-key` auth, its env vars — is concentrated in
// this one file. The runtime core depends only on ISessionGateway and
// never sees any of it. Mirrors how AwsSecretRepository concentrates AWS
// knowledge behind ISecretGateway.

function hostBase(): string | null {
  const raw = process.env.RANCH_API_URL ?? process.env.API_URL
  return raw ? raw.replace(/\/+$/, "") : null
}

function hostKey(): string | null {
  return process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY ?? null
}

function requireHost(): { base: string; key: string } {
  const base = hostBase()
  const key = hostKey()
  if (!base || !key) {
    throw new Error(
      "Session host not configured (RANCH_API_URL / BRIDLE_API_KEY missing in runtime env).",
    )
  }
  return { base, key }
}

export class RanchSessionRepository implements ISessionGateway {
  async list(): Promise<IRuntimeSession[]> {
    const { base, key } = requireHost()
    const res = await fetch(`${base}/integrations/internal/accounts`, {
      headers: { "x-bridle-api-key": key },
    })
    if (!res.ok) {
      throw new Error(`Session host returned ${res.status} ${res.statusText}`)
    }
    const body = (await res.json()) as
      | { accounts: IRuntimeSession[] }
      | { data: { accounts: IRuntimeSession[] } }
    const payload = "data" in body ? body.data : body
    return payload?.accounts ?? []
  }

  async getBrowserState(profile: string): Promise<unknown | null> {
    // Optional fallback for browser_play — never throw, just yield null.
    const base = hostBase()
    const key = hostKey()
    if (!base || !key) return null
    try {
      const url = new URL(`${base}/integrations/internal/browser-state`)
      url.searchParams.set("profile", profile)
      const res = await fetch(url.toString(), {
        headers: { "x-bridle-api-key": key },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: unknown }
      return body?.data ?? body
    } catch {
      return null
    }
  }

  async requestLogin(
    service: string,
    accountKey: string,
  ): Promise<ILoginInstruction | null> {
    const { base, key } = requireHost()
    const res = await fetch(`${base}/integrations/internal/request-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridle-api-key": key,
      },
      body: JSON.stringify({ service, accountKey }),
    })
    if (!res.ok) {
      throw new Error(`Session host returned ${res.status} ${res.statusText}`)
    }
    const body = (await res.json()) as
      | ILoginInstruction
      | { data: ILoginInstruction }
    return "data" in body ? body.data : body
  }

  async resolveSecrets(service?: string): Promise<Record<string, string>> {
    const { base, key } = requireHost()
    const url = new URL(`${base}/integrations/internal/secrets`)
    if (service) url.searchParams.set("service", service)
    const res = await fetch(url.toString(), {
      headers: { "x-bridle-api-key": key },
    })
    if (!res.ok) {
      throw new Error(`Session host returned ${res.status} ${res.statusText}`)
    }
    const body = (await res.json()) as
      | { env: Record<string, string> }
      | { data: { env: Record<string, string> } }
    const payload = "data" in body ? body.data : body
    return payload?.env ?? {}
  }
}
