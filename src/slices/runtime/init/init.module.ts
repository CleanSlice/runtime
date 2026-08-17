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

  /**
   * Re-read agent.config.json and merge it into the existing `config`
   * object IN PLACE — nested objects (e.g. `memory.limits`) keep their
   * identity rather than being replaced.
   *
   * Needed because `config` is captured once here at construction, which on
   * a fresh container filesystem happens BEFORE S3 restores the real
   * persisted `.agent/agent.config.json` (the constructor's `scaffold()`
   * call sees an empty disk and copies `.agent.example`'s config as a
   * placeholder in the meantime). Several slices — `MemoryModule` chief
   * among them — hold a direct reference to nested pieces of this object,
   * so callers should invoke this right after the S3 pull completes.
   */
  reload(): IAgentConfig {
    const fresh = this.service.reloadConfig(this.agentDir)
    deepAssignInPlace(this.config, fresh)
    return this.config
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deepAssignInPlace(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    const bothPlainObjects =
      sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
      tv !== null && typeof tv === "object" && !Array.isArray(tv)
    if (bothPlainObjects) {
      deepAssignInPlace(tv, sv)
    } else {
      target[key] = sv
    }
  }
}
