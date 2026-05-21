// A connected account the agent can act as — a logged-in browser
// session (mechanism "browser") or an API key (mechanism "secret").
export interface IRuntimeSession {
  service: string
  accountKey: string
  profile: string
  mechanism: "browser" | "secret"
  status: string
}

// Human-readable login instructions for a session whose cookies are
// missing or expired.
export interface ILoginInstruction {
  accountId: string
  siteUrl: string
  helpUrl: string
  instructions: string
}

/**
 * Port — where the runtime gets logged-in sessions, their cookies and
 * host-provided secrets.
 *
 * The runtime core (the `session_*` tools, `browser_play`) depends ONLY
 * on this interface. Each hosting environment ships an adapter under
 * `data/repositories/*`; Ranch is one adapter, `local` makes the runtime
 * run standalone with no host. Selected at boot by `SessionModule`.
 */
export interface ISessionGateway {
  /** Connected sessions — backs the `session_list` tool. */
  list(): Promise<IRuntimeSession[]>

  /**
   * Playwright `storageState` for a profile, or null when the host has
   * none. Non-throwing — it is an optional fallback for `browser_play`.
   */
  getBrowserState(profile: string): Promise<unknown | null>

  /**
   * Human login instructions for a browser session, or null when the
   * host cannot issue them.
   */
  requestLogin(
    service: string,
    accountKey: string,
  ): Promise<ILoginInstruction | null>

  /** Resolve secret-mechanism sessions into a flat env map. */
  resolveSecrets(service?: string): Promise<Record<string, string>>
}
