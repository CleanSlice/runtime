import type { IVoiceGateway } from "./voice.gateway"

export class VoiceService {
  private enabled: Set<string>

  constructor(private gateway: IVoiceGateway) {
    this.enabled = new Set(gateway.load())
  }

  isEnabled(userId: string): boolean {
    return this.enabled.has(userId)
  }

  enable(userId: string): void {
    this.enabled.add(userId)
    this.gateway.save([...this.enabled])
  }

  disable(userId: string): void {
    this.enabled.delete(userId)
    this.gateway.save([...this.enabled])
  }

  toggle(userId: string): boolean {
    if (this.isEnabled(userId)) {
      this.disable(userId)
      return false
    } else {
      this.enable(userId)
      return true
    }
  }
}
