import type { IDailyUsage } from "./usage.types"

export abstract class IUsageGateway {
  abstract load(): IDailyUsage | null
  abstract save(usage: IDailyUsage): void
  abstract report(botId: string, usage: IDailyUsage): Promise<void>
}
