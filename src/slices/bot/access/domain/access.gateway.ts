import type { UserRecord } from "./access.types"

export interface IAccessGateway {
  getUser(userId: string): UserRecord | undefined
  setUser(user: UserRecord): void
  getAllUsers(): UserRecord[]
  load(): void
  save(): void
}
