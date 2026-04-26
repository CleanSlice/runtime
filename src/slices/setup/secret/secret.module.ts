import type { ISecretGateway } from "./domain/secret.types"
import { FileSecretRepository } from "./data/repositories/file/file.repository"
import { AwsSecretRepository } from "./data/repositories/aws/aws.repository"

export class SecretModule {
  private gateway: ISecretGateway

  constructor(agentDir: string) {
    const provider = process.env.SECRET_PROVIDER ?? "file"
    if (provider === "aws") {
      const prefix = process.env.AWS_SECRET_PREFIX ?? "cleanslice/users"
      const region = process.env.AWS_REGION ?? "us-east-1"
      this.gateway = new AwsSecretRepository(prefix)
      console.log(`[secrets] using AWS Secrets Manager (region=${region}, prefix=${prefix})`)
    } else {
      this.gateway = new FileSecretRepository(agentDir)
      console.log(`[secrets] using file store (${agentDir}/data/secrets/)`)
    }
  }

  get(userId: string, key: string): Promise<string | undefined> {
    return this.gateway.get(userId, key)
  }

  set(userId: string, key: string, value: string): Promise<void> {
    return this.gateway.set(userId, key, value)
  }

  delete(userId: string, key: string): Promise<void> {
    return this.gateway.delete(userId, key)
  }

  list(userId: string): Promise<string[]> {
    return this.gateway.list(userId)
  }
}
