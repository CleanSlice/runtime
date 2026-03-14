import { AgentRuntime } from "./runtime"
import { ClaudeAdapter } from "./slices/adapters"
import { TelegramChannel } from "./slices/channel/data/telegram.channel"

const runtime = new AgentRuntime({
  model: new ClaudeAdapter({ model: "claude-sonnet-4-6" }),
  channels: [
    new TelegramChannel({ token: process.env.TELEGRAM_TOKEN ?? "" }),
  ],
})

await runtime.start()
console.log("🤖 Agent runtime started")
