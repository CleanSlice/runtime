import type { IActivityGateway } from "../domain/activity.gateway"
import type { IActivity } from "../domain/activity.types"
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs"

export class ActivityGateway implements IActivityGateway {
  private filePath: string

  constructor(agentDir: string) {
    this.filePath = `${agentDir}/activity.json`
  }

  set(activity: IActivity): void {
    writeFileSync(this.filePath, JSON.stringify(activity, null, 2))
  }

  get(): IActivity | null {
    try {
      if (!existsSync(this.filePath)) return null
      const raw = readFileSync(this.filePath, "utf-8")
      return JSON.parse(raw) as IActivity
    } catch {
      return null
    }
  }

  updateStep(step: string): void {
    const activity = this.get()
    if (!activity) return
    activity.lastStep = step
    writeFileSync(this.filePath, JSON.stringify(activity, null, 2))
  }

  clear(): void {
    try {
      unlinkSync(this.filePath)
    } catch {
      // file may not exist
    }
  }
}
