import { describe, expect, test } from "bun:test"
import { SourceRegistry, citeBlock, extractSources, finalizeBubble, normaliseUrl, stripMarkers } from "./sources"
import type { ISource } from "./loop.types"
import { WebSearchTool } from "../../../agent/tool/data/repositories/websearch/websearch.repository"
import { WebFetchTool } from "../../../agent/tool/data/repositories/websearch/webfetch.repository"
import { BrowserTool } from "../../../agent/tool/data/repositories/browser/browser.repository"

/**
 * What a reader sees under an answer is decided here (CLEAN-138): which
 * sources a tool result declared, which number each one got for the turn,
 * and what is left of the model's `[^n]` markers once the unknown ones are
 * gone and the rest are renumbered. Contract: ranch
 * `specs/020-chat-sources/contracts/sources.md`.
 */

const legal: ISource = { kind: "knowledge", id: "src-1", name: "Contract 2025.pdf", knowledgeId: "k1", knowledgeName: "Legal" }
const hr: ISource = { kind: "knowledge", id: "src-2", name: "Handbook.docx", knowledgeId: "k2", knowledgeName: null }
const site: ISource = { kind: "web", url: "https://example.com/page", title: "Example" }

describe("extractSources", () => {
  test("reads `sources` off a plain object result", () => {
    expect(extractSources({ answer: "…", sources: [legal] })).toEqual([legal])
  })

  test("walks `results[].sources` of a fan-out result", () => {
    const result = { results: [{ sources: [legal] }, { sources: [hr] }, { answer: "none" }] }
    expect(extractSources(result)).toEqual([legal, hr])
  })

  test("parses the JSON inside MCP text content", () => {
    const mcp = [
      { type: "text", text: JSON.stringify({ answer: "…", sources: [legal] }) },
      { type: "text", text: JSON.stringify({ results: [{ sources: [site] }] }) },
    ]
    expect(extractSources(mcp)).toEqual([legal, site])
  })

  test("ignores MCP text that is not JSON", () => {
    expect(extractSources([{ type: "text", text: "plain prose, no sources here" }])).toEqual([])
  })

  test("drops web entries whose url is not http(s), and malformed entries", () => {
    const result = {
      sources: [
        { kind: "web", url: "javascript:alert(1)", title: null },
        { kind: "web", url: "ftp://files.example.com/a", title: "ftp" },
        { kind: "web", url: "s3://bucket/key" },
        { kind: "knowledge", id: "x" },
        { kind: "video", url: "https://example.com" },
        site,
      ],
    }
    expect(extractSources(result)).toEqual([site])
  })

  test("fills a missing knowledgeName / title with null and keeps nothing else", () => {
    const result = {
      sources: [
        { kind: "knowledge", id: "src-9", name: "Doc", knowledgeId: "k9", excerpt: "secret text", score: 0.9 },
        { kind: "web", url: "https://example.com/x", storagePath: "/var/data" },
      ],
    }
    expect(extractSources(result)).toEqual([
      { kind: "knowledge", id: "src-9", name: "Doc", knowledgeId: "k9", knowledgeName: null },
      { kind: "web", url: "https://example.com/x", title: null },
    ])
  })

  test("returns nothing for results that carry no sources", () => {
    expect(extractSources(undefined)).toEqual([])
    expect(extractSources("just a string")).toEqual([])
    expect(extractSources({ error: "boom" })).toEqual([])
    expect(extractSources([{ title: "a", url: "https://a" }])).toEqual([])
  })
})

describe("normaliseUrl", () => {
  test("lower-cases scheme and host, drops the fragment, keeps path case and trailing slash", () => {
    expect(normaliseUrl("HTTPS://Example.COM/Docs/#section")).toBe("https://example.com/Docs/")
    expect(normaliseUrl("https://example.com/Docs")).toBe("https://example.com/Docs")
    expect(normaliseUrl("https://example.com/a?b=C#x")).toBe("https://example.com/a?b=C")
  })

  test("hands back what it cannot parse", () => {
    expect(normaliseUrl("not a url")).toBe("not a url")
  })
})

describe("SourceRegistry", () => {
  test("numbers sources from 1 in order of first sight and keeps the numbers stable", () => {
    const registry = new SourceRegistry()
    expect(registry.numberOf(legal)).toBe(1)
    expect(registry.numberOf(site)).toBe(2)
    expect(registry.numberOf(legal)).toBe(1)
    expect(registry.numberOf(hr)).toBe(3)
    expect(registry.numberOf(site)).toBe(2)
    expect(registry.entries).toEqual([legal, site, hr])
  })

  test("dedups knowledge by id even when the name changed", () => {
    const registry = new SourceRegistry()
    registry.numberOf(legal)
    expect(registry.numberOf({ ...legal, name: "Contract 2025 (renamed).pdf" })).toBe(1)
    expect(registry.entries).toHaveLength(1)
  })

  test("dedups web by normalised url", () => {
    const registry = new SourceRegistry()
    registry.numberOf(site)
    expect(registry.numberOf({ kind: "web", url: "HTTPS://EXAMPLE.com/page#top", title: null })).toBe(1)
    expect(registry.numberOf({ kind: "web", url: "https://example.com/page/", title: null })).toBe(2)
  })

  test("get returns the source behind a number, or undefined", () => {
    const registry = new SourceRegistry()
    registry.numberOf(legal)
    expect(registry.get(1)).toEqual(legal)
    expect(registry.get(0)).toBeUndefined()
    expect(registry.get(2)).toBeUndefined()
  })
})

describe("citeBlock", () => {
  test("renders one line the model can copy numbers from", () => {
    expect(citeBlock([
      { n: 3, source: legal },
      { n: 4, source: site },
    ])).toBe("Sources you may cite: [^3] «Contract 2025.pdf» (knowledge: Legal) · [^4] https://example.com/page (web)")
  })

  test("leaves the base name out when the tool did not name one", () => {
    expect(citeBlock([{ n: 1, source: hr }])).toBe("Sources you may cite: [^1] «Handbook.docx» (knowledge)")
  })

  test("renders nothing for an empty list", () => {
    expect(citeBlock([])).toBe("")
  })
})

describe("finalizeBubble", () => {
  function registryOf(...sources: ISource[]): SourceRegistry {
    const registry = new SourceRegistry()
    for (let i = 0; i < sources.length; i++) registry.numberOf(sources[i])
    return registry
  }

  test("removes markers the registry does not know", () => {
    const out = finalizeBubble("A [^1] B [^7]", registryOf(legal))
    expect(out.text).toBe("A [^1] B")
    expect(out.sources).toEqual([legal])
  })

  test("renumbers survivors densely by first appearance and lists sources in that order", () => {
    const out = finalizeBubble("First [^3]. Then [^1], and [^3] again.", registryOf(legal, site, hr))
    expect(out.text).toBe("First [^1]. Then [^2], and [^1] again.")
    expect(out.sources).toEqual([hr, legal])
  })

  test("leaves markers inside fenced and inline code alone and does not count them", () => {
    const text = "Use `[^1]` literally.\n\n```md\nfootnote [^2] here\n```\n\nReal cite [^2]."
    const out = finalizeBubble(text, registryOf(legal, site))
    expect(out.text).toBe("Use `[^1]` literally.\n\n```md\nfootnote [^2] here\n```\n\nReal cite [^1].")
    expect(out.sources).toEqual([site])
  })

  test("hands back the text unchanged when nothing is cited", () => {
    const out = finalizeBubble("No sources at all.", registryOf(legal))
    expect(out.text).toBe("No sources at all.")
    expect(out.sources).toEqual([])
  })

  test("drops every marker when the registry is empty", () => {
    const out = finalizeBubble("Made up [^1] and [^2].", new SourceRegistry())
    expect(out.text).toBe("Made up and.")
    expect(out.sources).toEqual([])
  })

  test("treats [^0] and a non-numeric footnote as unknown", () => {
    const out = finalizeBubble("Zero [^0] and [^note] stay out, [^1] stays.", registryOf(legal))
    expect(out.text).toBe("Zero and [^note] stay out, [^1] stays.")
  })
})

describe("stripMarkers", () => {
  test("removes every marker outside code", () => {
    expect(stripMarkers("A [^1] B [^12].")).toBe("A B.")
    expect(stripMarkers("Keep `[^1]` and\n```\n[^2]\n```\nbut not [^3]")).toBe("Keep `[^1]` and\n```\n[^2]\n```\nbut not")
  })

  test("is a no-op on text without markers", () => {
    expect(stripMarkers("plain")).toBe("plain")
  })
})

describe("built-in web tools declare their sources (T050)", () => {
  test("web_search: one web entry per result", () => {
    const result = [
      { title: "A", url: "https://a.example/", description: "…" },
      { title: "B", url: "http://b.example/x", description: "…" },
      { title: "bad", url: "ftp://c.example/", description: "…" },
    ]
    expect(WebSearchTool.sources!({ query: "q" }, result)).toEqual([
      { kind: "web", url: "https://a.example/", title: "A" },
      { kind: "web", url: "http://b.example/x", title: "B" },
    ])
  })

  test("web_fetch: the fetched page when the call succeeded, nothing on error", () => {
    expect(WebFetchTool.sources!({ url: "https://a.example/p" }, { url: "https://a.example/p", content: "…" }))
      .toEqual([{ kind: "web", url: "https://a.example/p", title: null }])
    expect(WebFetchTool.sources!({ url: "https://a.example/p" }, { error: "HTTP 404: Not Found", url: "https://a.example/p" }))
      .toEqual([])
  })

  test("browser: the visited page when chromium reported no error", () => {
    expect(BrowserTool.sources!({ url: "https://a.example/" }, { url: "https://a.example/", text: "…", length: 1, error: undefined }))
      .toEqual([{ kind: "web", url: "https://a.example/", title: null }])
    expect(BrowserTool.sources!({ url: "https://a.example/" }, { url: "https://a.example/", text: "", length: 0, error: "crashed" }))
      .toEqual([])
    expect(BrowserTool.sources!({ url: "file:///etc/passwd" }, { url: "file:///etc/passwd", text: "…", length: 1, error: undefined }))
      .toEqual([])
  })
})
