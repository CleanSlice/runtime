import type { RlmContextRef } from "../domain/rlm.types"

export interface IRangeChunk {
  content: string
  totalSize: number
  hasMore: boolean
}

// Thin fetch wrapper for Ranch's /rlm/internal/context/* endpoints (see
// api/src/slices/rlm/rlm-internal.controller.ts). Authenticated with the
// job-scoped token minted by AuthService.issueRlmJobToken - the API
// re-validates every request against that token's embedded scope, so this
// client doesn't need to duplicate any authorization logic.
export class RlmContextClient {
  constructor(
    private readonly ranchApiUrl: string,
    private readonly jobToken: string,
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.ranchApiUrl.replace(/\/$/, "")}${path}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.jobToken}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`RLM context fetch failed (${res.status}): ${path} ${body.slice(0, 200)}`)
    }
    const json = await res.json()
    // Ranch's global response interceptor wraps controller returns as
    // { success, data } - unwrap defensively so this client survives that
    // envelope changing shape.
    return (json?.data ?? json) as T
  }

  async queryKnowledge(knowledgeId: string, query: string): Promise<unknown> {
    const q = encodeURIComponent(query)
    return this.getJson(`/rlm/internal/context/knowledge/${knowledgeId}/query?query=${q}`)
  }

  async readSourceRange(sourceId: string, offset: number, limit: number): Promise<IRangeChunk> {
    return this.getJson(`/rlm/internal/context/source/${sourceId}/range?offset=${offset}&limit=${limit}`)
  }

  async readAgentFileRange(agentId: string, path: string, offset: number, limit: number): Promise<IRangeChunk> {
    const p = encodeURIComponent(path)
    const chunk = await this.getJson<{ content: string; totalSize: number; hasMore: boolean }>(
      `/rlm/internal/context/agent-file/${agentId}/range?path=${p}&offset=${offset}&limit=${limit}`,
    )
    return { content: chunk.content, totalSize: chunk.totalSize, hasMore: chunk.hasMore }
  }

  /**
   * Fetch a whole source/agentFile document by paging `range` until
   * `hasMore` is false, concatenating chunks. Capped so a misconfigured
   * source can't blow this job pod's memory - matches the 2 MB cap Ranch's
   * own internal controller already enforces for reins sources.
   */
  async readFullText(ref: RlmContextRef, maxBytes = 2 * 1024 * 1024): Promise<string> {
    if (ref.type === "knowledge") {
      throw new Error("readFullText is not supported for knowledge refs - use queryKnowledge instead")
    }
    const CHUNK = 65536
    let offset = 0
    let text = ""
    for (;;) {
      const chunk = ref.type === "source"
        ? await this.readSourceRange(ref.sourceId, offset, CHUNK)
        : await this.readAgentFileRange(ref.agentId, ref.path, offset, CHUNK)
      text += chunk.content
      offset += Buffer.byteLength(chunk.content, "utf-8")
      if (!chunk.hasMore || offset >= maxBytes) break
    }
    return text
  }
}
