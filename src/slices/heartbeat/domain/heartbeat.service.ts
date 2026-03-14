import type { IHeartbeatGateway } from "./heartbeat.gateway"

export class HeartbeatService {
  constructor(private gateway: IHeartbeatGateway) {}

  async shouldRun(): Promise<boolean> {
    return this.gateway.exists()
  }

  async getPrompt(defaultPrompt: string): Promise<string> {
    return defaultPrompt
  }
}
