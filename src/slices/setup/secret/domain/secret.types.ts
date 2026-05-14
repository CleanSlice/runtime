export type SecretStore = Record<string, string>

// `scope` is the storage partition key — the ranch agent id. Secrets are
// shared across all of an agent's channels, not split per channel user.
export interface ISecretGateway {
  get(scope: string, key: string): Promise<string | undefined>
  set(scope: string, key: string, value: string): Promise<void>
  delete(scope: string, key: string): Promise<void>
  list(scope: string): Promise<string[]>
}
