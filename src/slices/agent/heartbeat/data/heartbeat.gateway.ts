import { existsSync } from "fs"
import type { IHeartbeatGateway } from "../domain/heartbeat.gateway"

export class HeartbeatGateway implements IHeartbeatGateway {
  constructor(private agentDir: string) {}

  exists(): boolean {
    return existsSync(`${this.agentDir}/HEARTBEAT.md`)
  }

  async load(): Promise<string> {
    return Bun.file(`${this.agentDir}/HEARTBEAT.md`).text()
  }
}
