import type { IHeartbeatGateway } from "./heartbeat.gateway"

export type HeartbeatHandler = (prompt: string) => Promise<void>

export class HeartbeatService {
  constructor(private gateway: IHeartbeatGateway) {}

  async shouldRun(): Promise<boolean> {
    return this.gateway.exists()
  }

  async getPrompt(defaultPrompt: string): Promise<string> {
    return defaultPrompt
  }

  async tick(defaultPrompt: string, handler: HeartbeatHandler): Promise<void> {
    if (!await this.shouldRun()) return
    const prompt = await this.getPrompt(defaultPrompt)
    await handler(prompt)
  }
}
