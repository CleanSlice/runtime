import type { IMemoryGateway } from "./memory.gateway"
import type { MemoryEntry } from "./memory.types"
import type { Event } from "../../../setup/event"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { SessionModule } from "../../session/session.module"
import { buildAdminOwnerPrompt } from "../../agent/domain/prompts/admin-owner.prompt"
import { buildMemoryFlushPrompt } from "../../agent/domain/prompts/error-hint.prompt"

const MD_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]

export class MemoryService {
  constructor(private gateway: IMemoryGateway) {}

  // ─── Search / Insert ───────────────────────────────────────────────

  async load(agentDir: string): Promise<void> {
    for (const file of MD_FILES) {
      const path = `${agentDir}/${file}`
      try {
        const content = await Bun.file(path).text()
        this.gateway.insert({ id: file, content, source: file, ts: Date.now() })
      } catch {
        // file may not exist
      }
    }
  }

  insert(entry: MemoryEntry): void {
    this.gateway.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.gateway.search(query)
  }

  // ─── Daily memory ─────────────────────────────────────────────────

  appendDaily(text: string): void {
    this.gateway.appendDaily(text)
  }

  readRecentDaily(): string | undefined {
    return this.gateway.readRecentDaily()
  }

  // ─── Admin memory (MEMORY.md) ─────────────────────────────────────

  ensureAdminInMemory(adminIds: string[]): void {
    if (adminIds.length === 0) return

    const marker = "## Bot Owner"
    const ownerBlock = buildAdminOwnerPrompt(adminIds)
    const content = this.gateway.readMemoryFile()

    if (content) {
      if (content.includes(marker)) {
        const updated = content.replace(
          new RegExp(`${marker}[\\s\\S]*?(?=\\n## |$)`),
          ownerBlock,
        )
        this.gateway.writeMemoryFile(updated)
      } else {
        this.gateway.writeMemoryFile(content + "\n" + ownerBlock)
      }
    } else {
      this.gateway.writeMemoryFile(ownerBlock)
    }
    console.log(`[init] admin IDs written to MEMORY.md: ${adminIds.join(", ")}`)
  }

  // ─── Memory flush + compaction ─────────────────────────────────────

  flushAndCompact(sessionId: string, history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number): void {
    this.doFlush(sessionId, history, llm, session, compactionThreshold).catch(err =>
      console.error("[memory-flush] unhandled:", err)
    )
  }

  private async doFlush(sessionId: string, _history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number): Promise<void> {
    const events = await session.read(sessionId)
    if (events.length <= compactionThreshold) return

    console.log(`[memory-flush] flushing session ${sessionId} before compaction`)
    try {
      const existing = this.readRecentDaily() ?? ""
      // Memory flush + compaction are background summarization tasks — route
      // through the auxiliary LLM (cheaper model, no contention with the
      // main session's prompt cache). Falls back to main when no aux is set.
      const response = await llm.auxComplete(buildMemoryFlushPrompt(existing), events, [])

      const text = response.text?.trim()
      if (text && text !== "NOTHING") {
        this.appendDaily(text)
        console.log(`[memory-flush] saved ${text.split("\n").length} notes`)
      }
    } catch (err) {
      console.error("[memory-flush] failed:", err)
    }

    session.compactAsync(sessionId, llm.getAuxGateway())
  }
}
