import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs"
import { dirname } from "path"
import type { ToolContext } from "../../../domain/tool.types"

// Where a chat identity's browser sessions live in the agent dir (CLEAN-244):
// one folder per identity, `browser-state/<identity>/<profile>.json`.
//
// The old layout was flat, `browser-state/<identity>-<profile>.json`, and the
// dash is in ids and profile names alike, so two pairs could name one file:
// share visitor `share-abc-def` with profile `private`, and `share-abc` — a
// visitor picks the tail of their own id — asking for `def-private`. The
// second one signed in as the first.
//
// Ranch API writes the same paths for the Ranch Cookies extension
// (api/src/slices/browser/domain/browserStatePath.ts) — change them together.

/** The folder of a turn that acts for nobody: cron, heartbeat. `~` is never an encoded id's first character unencoded. */
export const AGENT_FOLDER = "~agent"

/**
 * An identity as a folder name, reversibly: letters, digits, `_` and `-` stay,
 * every other byte becomes `~` and two hex digits — `~` itself included, so
 * two ids never share a folder, and no folder is `.` or `..`.
 */
export function identityFolder(from: string | undefined): string {
  if (!from || from === "cron" || from === "heartbeat") return AGENT_FOLDER
  let out = ""
  for (const byte of Buffer.from(from, "utf8")) {
    const ch = String.fromCharCode(byte)
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `~${byte.toString(16).padStart(2, "0")}`
  }
  return out
}

// Mirrors BrowserGateway.canonicalAccountKey and
// UserBrowserStateGateway.objectKey on the ranch-api side — all three must
// lowercase and apply the same whitelist, so "Instagram" and "instagram" are
// one file.
export function canonicalProfile(profile: string): string {
  return profile.toLowerCase().replace(/[^a-z0-9_:\-.]/g, "_")
}

/** Where this identity's state for `profile` lives. */
export function statePath(ctx: Pick<ToolContext, "agentDir" | "from">, profile: string): string {
  return `${ctx.agentDir}/browser-state/${identityFolder(ctx.from)}/${canonicalProfile(profile)}.json`
}

/**
 * Ids whose old flat file name was never ambiguous, because no other id is
 * one of them with a dash and more after it: the Owner (`admin`), a console
 * account (`user-<uuid>`), and an id with no dash at all (a Telegram or
 * Slack user) other than the first word of a namespace that has dashes
 * after it. A share or anonymous visitor's id ends in a tail they chose.
 */
const LEGACY_SAFE_RE = /^(admin|user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_]+)$/
const NAMESPACE_WORDS = new Set(["user", "share", "anon", "peer", "handover", "agent"])

function legacySafe(from: string): boolean {
  return LEGACY_SAFE_RE.test(from) && !NAMESPACE_WORDS.has(from)
}

/**
 * An old-layout file a turn that acts for nobody wrote as
 * `browser-state/<profile>.json` — unless the name reads as a person's
 * (`admin-…`, `user-…`, `share-…`, `anon-…`, `<digits>-…`), which a cron turn
 * asking for that "profile" would otherwise have opened.
 */
const PERSON_FILE_RE = /^(admin|user|share|anon|\d+)-/

/** A file of the old layout this identity may still claim, or null. */
function legacyPath(ctx: Pick<ToolContext, "agentDir" | "from">, profile: string): string | null {
  const from = ctx.from
  const name = canonicalProfile(profile)
  if (!from || from === "cron" || from === "heartbeat") {
    return PERSON_FILE_RE.test(name) ? null : `${ctx.agentDir}/browser-state/${name}.json`
  }
  if (!legacySafe(from)) return null
  return `${ctx.agentDir}/browser-state/${from}-${name}.json`
}

/**
 * The state file to use for `profile`, moving an old-layout one into place
 * first when this identity may claim it. A share or anonymous visitor's old
 * file is never read: it could be somebody else's. The move is a rename, so
 * the S3 watcher uploads the new key and drops the old one.
 */
export function resolveStatePath(ctx: Pick<ToolContext, "agentDir" | "from">, profile: string): string {
  const path = statePath(ctx, profile)
  const legacy = legacyPath(ctx, profile)
  if (legacy && existsSync(legacy)) {
    if (existsSync(path)) {
      // The new file is the newer write (an import since the move): the
      // old one is only a stale duplicate.
      unlinkSync(legacy)
    } else {
      mkdirSync(dirname(path), { recursive: true })
      renameSync(legacy, path)
    }
  }
  return path
}

/**
 * The browser profiles this identity holds in this agent — what the Ranch
 * Cookies extension shared with it, plus any a browser_play or browser_login
 * saved. Its own folder, and the old-layout files it may still claim. A name
 * must be one `canonicalProfile` would write, and is capped, so a stray file
 * never puts arbitrary text in front of the model.
 */
export function savedProfiles(ctx: Pick<ToolContext, "agentDir" | "from">): string[] {
  if (!ctx.from || ctx.from === "cron" || ctx.from === "heartbeat") return []
  const root = `${ctx.agentDir}/browser-state`
  const names = new Set<string>()
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  for (const n of list(`${root}/${identityFolder(ctx.from)}`)) {
    if (n.endsWith(".json")) names.add(n.slice(0, -".json".length))
  }
  if (legacySafe(ctx.from)) {
    const prefix = `${ctx.from}-`
    for (const n of list(root)) {
      if (n.startsWith(prefix) && n.endsWith(".json")) names.add(n.slice(prefix.length, -".json".length))
    }
  }
  return [...names]
    .filter((p) => p.length > 0 && p.length <= 64 && p === canonicalProfile(p))
    .sort()
    .slice(0, 50)
}
