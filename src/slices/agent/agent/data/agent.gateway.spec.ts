import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentGateway } from "./agent.gateway"

const USER_EXAMPLE = "# USER.md — About You\n\n- **Name:** Unknown\n- **Timezone:** UTC\n"
const HEARTBEAT_EXAMPLE = "# HEARTBEAT.md\n\n## Tasks\n\n(empty — add reminders or periodic checks here)\n"

function dirs(): { agentDir: string; exampleDir: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-gateway-"))
  const agentDir = join(root, "agent")
  const exampleDir = join(root, "example")
  mkdirSync(agentDir)
  mkdirSync(exampleDir)
  writeFileSync(join(exampleDir, "USER.md"), USER_EXAMPLE)
  writeFileSync(join(exampleDir, "HEARTBEAT.md"), HEARTBEAT_EXAMPLE)
  writeFileSync(join(agentDir, "SOUL.md"), "# Soul\n")
  return { agentDir, exampleDir }
}

describe("curated files that still read as .agent.example shipped them stay out of the prompt (CLEAN-213)", () => {
  test("an untouched USER.md or HEARTBEAT.md is left out, even with CRLF line endings", async () => {
    const { agentDir, exampleDir } = dirs()
    writeFileSync(join(agentDir, "USER.md"), USER_EXAMPLE.replace(/\n/g, "\r\n"))
    writeFileSync(join(agentDir, "HEARTBEAT.md"), HEARTBEAT_EXAMPLE + "\n\n")

    const config = await new AgentGateway(exampleDir).load(agentDir)

    expect(config.soul).toBe("# Soul\n")
    expect(config.user).toBeUndefined()
    expect(config.heartbeat).toBeUndefined()
  })

  test("an edited file is read whole; a missing example leaves the file as it is", async () => {
    const { agentDir, exampleDir } = dirs()
    writeFileSync(join(agentDir, "USER.md"), "# USER.md\n\n- **Name:** Maksym\n")
    writeFileSync(join(agentDir, "MEMORY.md"), "# Memory\n\n- prefers metric units\n")

    const config = await new AgentGateway(exampleDir).load(agentDir)

    expect(config.user).toBe("# USER.md\n\n- **Name:** Maksym\n")
    expect(config.memory).toBe("# Memory\n\n- prefers metric units\n")
  })

  test("without an example dir every file is read as before", async () => {
    const { agentDir } = dirs()
    writeFileSync(join(agentDir, "USER.md"), USER_EXAMPLE)

    const config = await new AgentGateway().load(agentDir)

    expect(config.user).toBe(USER_EXAMPLE)
  })
})
