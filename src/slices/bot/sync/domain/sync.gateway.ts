/** Gateway for remote storage sync operations */
export interface ISyncGateway {
  /** Restore from remote (or one subdir); on the full restore deferred keys (chat transcripts) are only queued. */
  pull(subdir?: string): Promise<void>
  /** Download the keys pull() deferred. Resolves when the queue drains. */
  startBackgroundPull(): Promise<void>
  /** Fetch one deferred key now, ahead of the background queue. */
  hydrate(relPath: string): Promise<void>
  /** Drop a deferred key being deleted locally, and delete it remotely. */
  discard(relPath: string): void
  /** Differential push of local agent dir to remote — returns # of changed files actually uploaded. */
  push(): Promise<number>
  startWatcher(): void
  stopWatcher(): void
  startAutoSync(intervalSec: number): void
  stopAutoSync(): void
}
