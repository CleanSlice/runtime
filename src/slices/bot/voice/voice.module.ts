import { VoiceService } from "./domain/voice.service"
import { VoiceGateway } from "./data/voice.gateway"

export class VoiceModule {
  private service: VoiceService

  constructor(agentDir: string) {
    this.service = new VoiceService(new VoiceGateway(agentDir))
  }

  isEnabled(userId: string): boolean {
    return this.service.isEnabled(userId)
  }

  toggle(userId: string): boolean {
    return this.service.toggle(userId)
  }

  enable(userId: string): void {
    this.service.enable(userId)
  }

  disable(userId: string): void {
    this.service.disable(userId)
  }
}
