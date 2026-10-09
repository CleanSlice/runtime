import type { ISource } from "./loop.types"

/**
 * Sources an answer may cite (CLEAN-138).
 *
 * The runtime is the only thing that sees every tool result — web lookups
 * never pass through the hub, and a knowledge lookup reaches the hub only
 * as an MCP call — so it alone numbers the sources of a turn, tells the
 * model which numbers exist, and checks what the model wrote against that
 * list before a bubble goes out. The hub owns what a source *is* (names,
 * policy, ratings); it never parses text. Contract: ranch
 * `specs/020-chat-sources/contracts/sources.md`.
 */

/** A marker as the model writes it, with the horizontal space before it — removing the one removes the other. */
const MARKER_RE = /[ \t]*\[\^(\d+)\]/g

/**
 * Code the model wrote stays as written: a fenced block (``` or ~~~, with
 * its closing fence) or an inline span. `[^1]` inside either is text about
 * footnotes, not a citation. An unclosed fence does not match and its body
 * is treated as prose — a finished bubble has its fences closed.
 */
const CODE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/** Lower-case scheme and host, drop the fragment; path, query and trailing slash stay as given. Dedup key only — never shown. */
export function normaliseUrl(url: string): string {
  try {
    // URL already lower-cases scheme and host. It also gives a bare host the
    // pathname "/" — put that back the way it was written.
    const u = new URL(url)
    const wroteSlash = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(url)
    const path = u.pathname === "/" && !wroteSlash ? "" : u.pathname
    return `${u.protocol}//${u.host}${path}${u.search}`
  } catch {
    return url
  }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value)
}

/**
 * One declared source, or nothing. Only the fields the contract names
 * survive — a tool that puts an excerpt or a storage path beside them does
 * not get it forwarded to a reader by accident.
 */
function toSource(value: unknown): ISource | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (v.kind === "knowledge") {
    if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.knowledgeId !== "string") return undefined
    return {
      kind: "knowledge",
      id: v.id,
      name: v.name,
      knowledgeId: v.knowledgeId,
      knowledgeName: typeof v.knowledgeName === "string" ? v.knowledgeName : null,
    }
  }
  if (v.kind === "web") {
    if (!isHttpUrl(v.url)) return undefined
    return { kind: "web", url: v.url, title: typeof v.title === "string" ? v.title : null }
  }
  return undefined
}

function collectFrom(value: unknown, out: ISource[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (Array.isArray(v.sources)) {
    for (let i = 0; i < v.sources.length; i++) {
      const source = toSource(v.sources[i])
      if (source) out.push(source)
    }
  }
  // The fan-out form `{ results: [...] }` carries `sources` on each result.
  if (Array.isArray(v.results)) {
    for (let i = 0; i < v.results.length; i++) collectFrom(v.results[i], out)
  }
}

/**
 * The sources a raw tool result declares, in the order it lists them. Reads
 * `sources` and `results[].sources` off a plain object; for an MCP result
 * (`[{ type: "text", text }]`) parses each text that is JSON and reads the
 * same keys — any server that follows the shape is picked up, whatever the
 * tool is called. Non-JSON text is ignored. Web entries without an http(s)
 * url are dropped here, the first place that sees them.
 */
export function extractSources(result: unknown): ISource[] {
  const out: ISource[] = []
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i++) {
      const item = result[i] as { type?: unknown; text?: unknown } | null
      if (!item || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(item.text)
      } catch {
        continue
      }
      collectFrom(parsed, out)
    }
    return out
  }
  collectFrom(result, out)
  return out
}

/**
 * The numbers handed to the model for one turn. Index + 1 is the number: a
 * source first seen in the second tool call keeps its number in the fifth,
 * so a `[^3]` means the same thing wherever in the turn it was written.
 * Lives for one `LoopService.run()`; nothing is persisted from it except
 * what a bubble actually cites.
 */
export class SourceRegistry {
  readonly entries: ISource[] = []
  private readonly index = new Map<string, number>()

  private keyOf(source: ISource): string {
    return source.kind === "knowledge" ? `knowledge:${source.id}` : `web:${normaliseUrl(source.url)}`
  }

  /** The source's number, assigning the next one when it is new. */
  numberOf(source: ISource): number {
    const key = this.keyOf(source)
    const known = this.index.get(key)
    if (known !== undefined) return known
    this.entries.push(source)
    const n = this.entries.length
    this.index.set(key, n)
    return n
  }

  /** The source behind a number the model wrote, if it exists. */
  get(n: number): ISource | undefined {
    return Number.isInteger(n) && n >= 1 && n <= this.entries.length ? this.entries[n - 1] : undefined
  }
}

/**
 * The block that rides with a tool result so the model knows which numbers
 * it may cite. One line, the numbers in registry order, nothing the model
 * has to parse: `[^3] «Contract 2025.pdf» (knowledge: Legal) · [^4] https://… (web)`.
 */
export function citeBlock(entries: Array<{ n: number; source: ISource }>): string {
  if (entries.length === 0) return ""
  const items: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const { n, source } = entries[i]
    items.push(source.kind === "knowledge"
      ? `[^${n}] «${source.name}» (knowledge${source.knowledgeName ? `: ${source.knowledgeName}` : ""})`
      : `[^${n}] ${source.url} (web)`)
  }
  return `Sources you may cite: ${items.join(" · ")}`
}

/**
 * Runs `fn` over the prose of a markdown text, leaving code as it is. The
 * split regex captures the code, so odd segments are code and even ones
 * are prose.
 */
function mapProse(text: string, fn: (prose: string) => string): string {
  const segments = text.split(CODE_RE)
  for (let i = 0; i < segments.length; i += 2) segments[i] = fn(segments[i])
  return segments.join("")
}

/**
 * One finished bubble, checked against the turn's registry: markers the
 * registry does not know are removed, the survivors are renumbered densely
 * in order of first appearance, and `sources` lists what they point at in
 * that same order — index + 1 is the number now in the text. A bubble that
 * cites nothing comes back unchanged with an empty list.
 */
export function finalizeBubble(text: string, registry: SourceRegistry): { text: string; sources: ISource[] } {
  const renumbered = new Map<number, number>()
  const sources: ISource[] = []
  const out = mapProse(text, (prose) => prose.replace(MARKER_RE, (match, digits: string) => {
    const n = Number(digits)
    const source = registry.get(n)
    if (!source) return ""
    let next = renumbered.get(n)
    if (next === undefined) {
      sources.push(source)
      next = sources.length
      renumbered.set(n, next)
    }
    const space = match.slice(0, match.indexOf("["))
    return `${space}[^${next}]`
  }))
  return { text: out, sources }
}

/**
 * Every `[^n]` outside code removed. For channels and clients that cannot
 * show a source list the marker is noise — the model had no numbers to cite,
 * so whatever it wrote points at nothing.
 */
export function stripMarkers(text: string): string {
  return mapProse(text, (prose) => prose.replace(MARKER_RE, ""))
}
