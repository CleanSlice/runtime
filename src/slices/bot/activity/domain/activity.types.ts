export interface IActivity {
  taskId: string
  label: string
  userId: string
  channel: string
  text: string
  startedAt: number
  lastStep: string
}

export interface IRecoveryMessage {
  channel: string
  userId: string
  message: string
}
