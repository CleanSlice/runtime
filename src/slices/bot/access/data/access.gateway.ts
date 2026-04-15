import { mkdirSync, readFileSync, writeFileSync } from "fs"
import type { IAccessGateway } from "../domain/access.gateway"
import type { UserRecord, StrategyOverride } from "../domain/access.types"

interface AccessStore {
  users: Record<string, UserRecord>
  strategyOverride?: StrategyOverride
}

export class AccessGateway implements IAccessGateway {
  private storePath: string
  private store: AccessStore = { users: {} }

  constructor(agentDir: string) {
    this.storePath = `${agentDir}/data/access.json`
    mkdirSync(`${agentDir}/data`, { recursive: true })
    this.load()
  }

  load(): void {
    try {
      const text = readFileSync(this.storePath, "utf-8")
      this.store = JSON.parse(text)
    } catch {
      this.store = { users: {} }
    }
  }

  save(): void {
    writeFileSync(this.storePath, JSON.stringify(this.store, null, 2))
  }

  getUser(userId: string): UserRecord | undefined {
    return this.store.users[userId]
  }

  setUser(user: UserRecord): void {
    this.store.users[user.userId] = user
  }

  getAllUsers(): UserRecord[] {
    return Object.values(this.store.users)
  }

  getStrategyOverride(): StrategyOverride | undefined {
    return this.store.strategyOverride
  }

  setStrategyOverride(override: StrategyOverride | undefined): void {
    if (override) this.store.strategyOverride = override
    else delete this.store.strategyOverride
  }
}
