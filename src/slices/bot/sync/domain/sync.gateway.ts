/** Gateway for remote storage sync operations */
export interface ISyncGateway {
  pull(): Promise<void>
  push(): Promise<void>
  startWatcher(): void
  stopWatcher(): void
  startAutoSync(intervalSec: number): void
  stopAutoSync(): void
}
