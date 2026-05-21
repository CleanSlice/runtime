import type { ISessionGateway } from "./domain/session.types"
import { RanchSessionRepository } from "./data/repositories/ranch/ranch.repository"
import { LocalSessionRepository } from "./data/repositories/local/local.repository"
import { createLogger } from "../logger"

const log = createLogger("session")

/**
 * Picks the session adapter at boot and exposes it to the runtime.
 *
 * The runtime core knows nothing about Ranch — it talks to this module,
 * which resolves one ISessionGateway implementation. Mirrors SecretModule
 * (file vs aws). `SESSION_PROVIDER` overrides; the default is `ranch`
 * when a host API URL is present, else `local` (fully standalone).
 */
export class SessionModule {
  private gateway: ISessionGateway

  constructor(agentDir: string) {
    const hasHost = !!(process.env.RANCH_API_URL ?? process.env.API_URL)
    const provider = process.env.SESSION_PROVIDER ?? (hasHost ? "ranch" : "local")

    if (provider === "ranch") {
      this.gateway = new RanchSessionRepository()
      log.info("using ranch host adapter")
    } else {
      this.gateway = new LocalSessionRepository(agentDir)
      log.info(`using local adapter (${agentDir}/sessions/)`)
    }
  }

  list() {
    return this.gateway.list()
  }

  getBrowserState(profile: string) {
    return this.gateway.getBrowserState(profile)
  }

  requestLogin(service: string, accountKey: string) {
    return this.gateway.requestLogin(service, accountKey)
  }

  resolveSecrets(service?: string) {
    return this.gateway.resolveSecrets(service)
  }
}
