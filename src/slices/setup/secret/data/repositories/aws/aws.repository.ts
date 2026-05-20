import type { ISecretGateway, SecretStore } from "../../../domain/secret.types"
import { createLogger } from "../../../../logger"

const log = createLogger("secrets")

/**
 * AWS Secrets Manager backend.
 * Each agent = one secret: "<prefix>/<agentId>"
 * Value: JSON object with all of that agent's keys.
 *
 * Requires: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or IAM role)
 */
export class AwsSecretRepository implements ISecretGateway {
  private prefix: string
  private client: unknown = null

  constructor(prefix = "cleanslice/users") {
    this.prefix = prefix
  }

  private async getClient() {
    if (this.client) return this.client as import("@aws-sdk/client-secrets-manager").SecretsManagerClient
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager")
    this.client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" })
    return this.client as import("@aws-sdk/client-secrets-manager").SecretsManagerClient
  }

  private secretName(scope: string): string {
    const safe = scope.replace(/[^a-zA-Z0-9_\-:.]/g, "_")
    return `${this.prefix}/${safe}`
  }

  private async load(scope: string): Promise<SecretStore> {
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager")
    const client = await this.getClient()
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: this.secretName(scope) }))
      if (res.SecretString) return JSON.parse(res.SecretString) as SecretStore
      return {}
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "ResourceNotFoundException") return {}
      throw err
    }
  }

  private async save(scope: string, store: SecretStore): Promise<void> {
    const { PutSecretValueCommand, CreateSecretCommand } = await import("@aws-sdk/client-secrets-manager")
    const client = await this.getClient()
    const name = this.secretName(scope)
    const value = JSON.stringify(store)
    const keyCount = Object.keys(store).length
    try {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }))
      log.info(`put ${name} (${keyCount} keys)`)
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "ResourceNotFoundException") {
        try {
          await client.send(new CreateSecretCommand({ Name: name, SecretString: value }))
          log.ok(`created ${name} (${keyCount} keys)`)
        } catch (createErr: unknown) {
          const e = createErr as { name?: string; message?: string }
          log.error(`create failed ${name}: ${e.name ?? ""} ${e.message ?? String(createErr)}`)
          throw createErr
        }
      } else {
        const e = err as { name?: string; message?: string }
        log.error(`put failed ${name}: ${e.name ?? ""} ${e.message ?? String(err)}`)
        throw err
      }
    }
  }

  async get(scope: string, key: string): Promise<string | undefined> {
    const store = await this.load(scope)
    return store[key]
  }

  async set(scope: string, key: string, value: string): Promise<void> {
    const store = await this.load(scope)
    store[key] = value
    await this.save(scope, store)
  }

  async delete(scope: string, key: string): Promise<void> {
    const store = await this.load(scope)
    delete store[key]
    await this.save(scope, store)
  }

  async list(scope: string): Promise<string[]> {
    const store = await this.load(scope)
    return Object.keys(store)
  }
}
