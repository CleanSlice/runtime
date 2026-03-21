import type { ISecretGateway, SecretStore } from "../../../domain/secret.types"

/**
 * AWS Secrets Manager backend.
 * Each user = one secret: "cleanslice/users/<userId>"
 * Value: JSON object with all their keys.
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

  private secretName(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_\-:.]/g, "_")
    return `${this.prefix}/${safe}`
  }

  private async load(userId: string): Promise<SecretStore> {
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager")
    const client = await this.getClient()
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: this.secretName(userId) }))
      if (res.SecretString) return JSON.parse(res.SecretString) as SecretStore
      return {}
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "ResourceNotFoundException") return {}
      throw err
    }
  }

  private async save(userId: string, store: SecretStore): Promise<void> {
    const { PutSecretValueCommand, CreateSecretCommand } = await import("@aws-sdk/client-secrets-manager")
    const client = await this.getClient()
    const name = this.secretName(userId)
    const value = JSON.stringify(store)
    try {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }))
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "ResourceNotFoundException") {
        await client.send(new CreateSecretCommand({ Name: name, SecretString: value }))
      } else {
        throw err
      }
    }
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    const store = await this.load(userId)
    return store[key]
  }

  async set(userId: string, key: string, value: string): Promise<void> {
    const store = await this.load(userId)
    store[key] = value
    await this.save(userId, store)
  }

  async delete(userId: string, key: string): Promise<void> {
    const store = await this.load(userId)
    delete store[key]
    await this.save(userId, store)
  }

  async list(userId: string): Promise<string[]> {
    const store = await this.load(userId)
    return Object.keys(store)
  }
}
