// Secret redaction for log output.
//
// Every formatted log message passes through `redact()` before it is written,
// so a credential that accidentally ends up in a log string (an error body, a
// stringified config, a URL) never reaches stdout. Matches are masked to a
// short recognizable head — enough to debug "which key", not enough to use.

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{8,}/g,                                      // Anthropic API keys & OAuth tokens
  /sk-[a-zA-Z0-9]{20,}/g,                                           // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,                                          // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                              // Slack tokens
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,                               // Telegram bot tokens
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,                                 // Authorization headers
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,    // JWTs
]

function mask(secret: string): string {
  if (secret.length <= 12) return "•••"
  return `${secret.slice(0, 6)}…${secret.slice(-2)}`
}

/** Replace any secret-shaped substring with a masked placeholder. */
export function redact(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, mask)
  // credentials embedded in URLs: scheme://user:password@host
  out = out.replace(/(\/\/[^/\s:@]+:)([^@\s/]+)(@)/g, (_m, head, _pw, tail) => `${head}•••${tail}`)
  return out
}
