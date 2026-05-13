import { resolve } from "path"
import type { IAgentConfig } from "./domain/init.types"
import { InitService } from "./domain/init.service"
import { InitGateway } from "./data/init.gateway"

export class InitModule {
  readonly agentDir: string
  readonly exampleDir: string
  readonly config: IAgentConfig

  private service: InitService

  constructor(agentDir: string, exampleDir: string) {
    this.agentDir = resolve(agentDir)
    this.exampleDir = resolve(exampleDir)
    this.service = new InitService(new InitGateway())
    this.config = this.service.bootstrap(this.agentDir, this.exampleDir)
  }
}
