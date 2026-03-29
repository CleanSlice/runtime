import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs"

export interface IActivity {
  taskId: string
  label: string
  userId: string
  channel: string
  text: string
  startedAt: number
  lastStep: string
}

export class ActivityTracker {
  private filePath: string

  constructor(agentDir: string) {
    this.filePath = `${agentDir}/activity.json`
  }

  /** Record that a task has started */
  set(activity: IActivity): void {
    writeFileSync(this.filePath, JSON.stringify(activity, null, 2))
  }

  /** Update the last step (e.g. "tool_call: browser") */
  updateStep(step: string): void {
    const activity = this.get()
    if (!activity) return
    activity.lastStep = step
    writeFileSync(this.filePath, JSON.stringify(activity, null, 2))
  }

  /** Clear — task completed or cancelled normally */
  clear(): void {
    try {
      unlinkSync(this.filePath)
    } catch {
      // file may not exist
    }
  }

  /** Read interrupted activity (if any) — used on startup */
  get(): IActivity | null {
    try {
      if (!existsSync(this.filePath)) return null
      const raw = readFileSync(this.filePath, "utf-8")
      return JSON.parse(raw) as IActivity
    } catch {
      return null
    }
  }
}
