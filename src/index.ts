import { AgentRuntime } from "./runtime"
import { ClaudeLlm } from "./slices/llm"
import { ChannelGateway } from "./slices/channel/data/telegram.channel"

const runtime = new AgentRuntime({
  model: new ClaudeLlm({ model: "claude-sonnet-4-6" }),
  channels: [
    new ChannelGateway({ token: process.env.TELEGRAM_TOKEN ?? "" }),
  ],
})

await runtime.start()
console.log("🤖 Agent runtime started")
