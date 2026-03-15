export type SecretStore = Record<string, string>

export interface ISecretGateway {
  get(userId: string, key: string): Promise<string | undefined>
  set(userId: string, key: string, value: string): Promise<void>
  delete(userId: string, key: string): Promise<void>
  list(userId: string): Promise<string[]>
}
