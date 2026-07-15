// Lightweight per-message signal emitted from the single persistence funnel
// (SessionService.append) so the ranch chat index can update live, without
// waiting for the S3 reconcile interval. Carries metadata only — the message
// content still lives in the JSONL/S3.
export interface SessionActivity {
  sessionKey: string // "{channel}:{externalUserId}" — the JSONL basename
  channel: string
  externalUserId: string
  eventId: string // Event.id — dedup watermark on the ranch side
  role: "user" | "assistant"
  ts: number
  preview: string // truncated message text for the list row
}

/**
 * Port for reporting session activity. No-op by default; the BridleRepository
 * registers a transport that emits over the always-on agent↔hub socket when
 * connected. Agents without a hub connection simply drop these — the S3
 * reconcile is the safety net.
 */
export interface IActivityReporter {
  report(activity: SessionActivity): void
}
