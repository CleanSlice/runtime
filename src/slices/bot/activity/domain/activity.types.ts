export interface IActivity {
  taskId: string
  label: string
  userId: string
  channel: string
  text: string
  startedAt: number
  lastStep: string
}

export interface IRecoveryContext {
  channel: string
  userId: string
  /** System-role instruction injected back into the agent so it silently resumes the interrupted task. */
  instruction: string
}
