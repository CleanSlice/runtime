import type { ISecretGateway } from "./domain/secret.types"
import { FileSecretRepository } from "./data/repositories/file/file.repository"
import { AwsSecretRepository } from "./data/repositories/aws/aws.repository"
import { createLogger } from "../logger"

const log = createLogger("secrets")

export class SecretModule {
  private gateway: ISecretGateway
  // Secrets are scoped to the agent, not the channel user — the same store is
  // shared no matter which channel (Telegram, Slack, …) a secret was set from.
  private scope: string

  constructor(agentDir: string) {
    this.scope = process.env.AGENT_ID ?? process.env.BRIDLE_AGENT_ID ?? ""
    const provider = process.env.SECRET_PROVIDER ?? "file"
    if (provider === "aws") {
      const prefix = process.env.AWS_SECRET_PREFIX ?? "cleanslice/users"
      const region = process.env.AWS_REGION ?? "us-east-1"
      this.gateway = new AwsSecretRepository(prefix)
      log.info(`using AWS Secrets Manager (region=${region}, prefix=${prefix}, scope=${this.scope})`)
    } else {
      this.gateway = new FileSecretRepository(agentDir)
      log.info(`using file store (${agentDir}/data/secrets/, scope=${this.scope})`)
    }
  }

  get(key: string): Promise<string | undefined> {
    return this.gateway.get(this.scope, key)
  }

  set(key: string, value: string): Promise<void> {
    return this.gateway.set(this.scope, key, value)
  }

  delete(key: string): Promise<void> {
    return this.gateway.delete(this.scope, key)
  }

  list(): Promise<string[]> {
    return this.gateway.list(this.scope)
  }
}
