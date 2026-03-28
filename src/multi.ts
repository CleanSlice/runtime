/**
 * Multi-agent entrypoint — runs multiple agents in a single process.
 *
 * Shared across all agents:
 *   - Bun runtime (~30 MB)
 *   - Anthropic SDK (loaded once on first message)
 *   - AWS SDK (loaded once on first S3 call)
 *   - Tool definitions (Playwright, browser, etc.)
 *
 * Isolated per agent:
 *   - .agent/ directory (SOUL.md, MEMORY.md, sessions, skills)
 *   - Telegram token + admin IDs
 *   - Session state, cron, heartbeat
 *
 * Config: reads agents.json from CWD or AGENTS_CONFIG env var.
 *
 * agents.json format:
 * [
 *   {
 *     "name": "my-agent",
 *     "agentDir": ".agent-myagent",
 *     "env": {
 *       "TELEGRAM_BOT_TOKEN": "123:ABC",
 *       "TELEGRAM_BOT_NAME": "my_bot",
 *       "TELEGRAM_BOT_ADMIN_IDS": "55212224"
 *     }
 *   }
 * ]
 *
 * Any env var in "env" overrides process.env for that agent only.
 * Shared env vars (CLAUDE_CODE_OAUTH_TOKEN, S3_BUCKET, etc.) come from process.env.
 */

import { readFileSync, existsSync } from "fs"

// Load .env file (shared env for all agents)
if (existsSync(".env")) {
  const lines = readFileSync(".env", "utf-8").split("\n")
  for (const line of lines) {
    const [key, ...rest] = line.split("=")
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim()
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] caught:", reason)
})

import { AgentRuntime } from "./runtime"
import { ToolGateway } from "./slices/agent/tool/data/tool.gateway"
import { InitModule } from "./slices/agent/init"

interface AgentConfig {
  name: string
  agentDir?: string
  exampleDir?: string
  env?: Record<string, string>
}

// --- Load agents config ---
const configPath = process.env.AGENTS_CONFIG ?? "agents.json"
if (!existsSync(configPath)) {
  console.error(`[multi] agents config not found: ${configPath}`)
  console.error(`[multi] Create agents.json or set AGENTS_CONFIG env var. See src/multi.ts for format.`)
  process.exit(1)
}

const agents: AgentConfig[] = JSON.parse(readFileSync(configPath, "utf-8"))
console.log(`[multi] loading ${agents.length} agent(s) from ${configPath}`)

// --- Shared tools (registered once, used by all agents) ---
const toolGateway = new ToolGateway()
const sharedTools = toolGateway.getAll()

// --- Start each agent ---
const runtimes: AgentRuntime[] = []

for (const agent of agents) {
  const agentEnv = { ...process.env, ...agent.env }
  const agentDir = agent.agentDir ?? `.agent-${agent.name}`
  const exampleDir = agent.exampleDir ?? ".agent.example"

  console.log(`[multi] starting agent "${agent.name}" (agentDir: ${agentDir})`)

  // Temporarily override process.env for this agent's init
  const savedEnv = { ...process.env }
  Object.assign(process.env, agentEnv)

  try {
    const init = new InitModule(agentDir, exampleDir)

    const runtime = new AgentRuntime({
      init,
      llm: { provider: "claude", model: agentEnv.CLAUDE_MODEL },
      channels: [
        { type: "telegram", token: agentEnv.TELEGRAM_BOT_TOKEN ?? "" },
        ...(agentEnv.SLACK_BOT_TOKEN && agentEnv.SLACK_APP_TOKEN ? [{
          type: "slack" as const,
          botToken: agentEnv.SLACK_BOT_TOKEN,
          appToken: agentEnv.SLACK_APP_TOKEN,
        }] : []),
      ],
      tools: sharedTools,
    })

    await runtime.start()
    runtimes.push(runtime)
    console.log(`[multi] ✅ agent "${agent.name}" started`)
  } catch (err) {
    console.error(`[multi] ❌ agent "${agent.name}" failed to start:`, err)
  } finally {
    // Restore process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
  }
}

console.log(`[multi] ${runtimes.length}/${agents.length} agent(s) running`)

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  console.log(`[multi] received ${signal}, stopping ${runtimes.length} agent(s)...`)
  await Promise.allSettled(runtimes.map(r => r.stop()))
  console.log("[multi] clean exit")
  process.exit(0)
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

// --- Health check server ---
Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch() {
    const agentList = agents.map(a => `<li>🤖 <strong>${a.name}</strong> — @${a.env?.TELEGRAM_BOT_NAME ?? "?"}</li>`).join("\n")
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CleanSlice Multi-Agent</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #333; }
      h1 { font-size: 1.8rem; margin-bottom: 8px; }
      p { color: #666; }
      ul { list-style: none; padding: 0; }
      li { padding: 8px 0; border-bottom: 1px solid #eee; }
    </style>
  </head>
  <body>
    <h1>🤖 Multi-Agent Runtime</h1>
    <p>${runtimes.length} agent(s) running</p>
    <ul>${agentList}</ul>
  </body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    )
  },
})
console.log(`[multi] 🌐 HTTP server listening on port ${process.env.PORT ?? 3000}`)
