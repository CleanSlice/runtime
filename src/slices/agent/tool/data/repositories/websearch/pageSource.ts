import type { ISource } from "../../../../../runtime/loop/domain/loop.types"

/**
 * `Tool.sources` for the tools that read one page (`web_fetch`, `browser`,
 * CLEAN-138): the page is the source when the call succeeded. Both tools
 * put the address back on the result as `url` and report failure as
 * `error`, so one reader serves both. A page nobody could open is not a
 * source, and a non-http(s) address (file:, data:) is never one.
 */
export function fetchedPageSource(_params: unknown, result: unknown): ISource[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return []
  const r = result as { url?: unknown; error?: unknown }
  if (r.error) return []
  if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) return []
  return [{ kind: "web", url: r.url, title: null }]
}
