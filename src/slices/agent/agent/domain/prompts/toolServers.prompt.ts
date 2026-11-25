/** A tool server as this prompt needs it: its name and whether it is still being tried. */
export interface IPromptToolServer {
  name: string
  state: "connected" | "retrying" | "refused"
}

const WHY: Record<Exclude<IPromptToolServer["state"], "connected">, string> = {
  retrying: "still trying to reconnect",
  refused: "not reconnecting — needs an administrator",
}

/**
 * What the model is told when a tool server is missing (CLEAN-245). Without
 * it the tooling section simply lacks the server, and the model improvises
 * "try again in a few minutes" — also for a server no waiting will bring
 * back. Undefined when nothing is missing: the prompt is then unchanged.
 */
export function buildToolServersPrompt(servers: IPromptToolServer[]): string | undefined {
  const missing = servers.filter((s) => s.state !== "connected")
  if (missing.length === 0) return undefined
  const list = missing.map((s) => `${s.name} (${WHY[s.state as "retrying" | "refused"]})`).join(", ")
  const retry = missing.some((s) => s.state === "retrying")
    ? "Tell the person to try again shortly only for the ones marked as still reconnecting."
    : "Do not tell the person to try again later: waiting will not bring these back."
  return (
    `Some of your tools are not available right now: ${list}. ` +
    `Do not answer from memory what those tools would have told you. ` +
    `Say plainly that this part is unavailable. ${retry}`
  )
}
