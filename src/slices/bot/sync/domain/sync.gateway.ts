/** Gateway for remote storage sync operations */
export interface ISyncGateway {
  pull(): Promise<void>
  /** Differential push of local agent dir to remote — returns # of changed files actually uploaded. */
  push(): Promise<number>
  startWatcher(): void
  stopWatcher(): void
  startAutoSync(intervalSec: number): void
  stopAutoSync(): void
}
