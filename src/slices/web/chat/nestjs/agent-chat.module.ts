import { Module, type DynamicModule } from '@nestjs/common'
import { AgentChatController } from './agent-chat.controller'
import { ChatWsGateway } from './agent-chat.ws-gateway'
import { AgentWsGateway } from './agent-chat.agent-ws'
import { IAgentChatGateway } from './domain'
import { AgentChatGateway } from './data'

/**
 * Agent Chat Module — hub between browsers and the agent.
 *
 * The agent connects to the API as a WS client on /ws/agent
 * Browsers connect on /ws/chat
 * The API routes messages between them.
 *
 * Usage:
 *
 * ```ts
 * // app.module.ts
 * import { AgentChatModule } from '#agent-chat/agent-chat.module'
 *
 * @Module({
 *   imports: [AgentChatModule],
 * })
 * export class AppModule {}
 * ```
 *
 * WebSocket endpoints:
 *   /ws/agent  — agent runtime connection
 *   /ws/chat   — browser client connection
 *
 * HTTP endpoints:
 *   POST /api/agent/message  — HTTP fallback for sending messages
 *   GET  /api/agent/health   — agent connection status
 */
@Module({
  providers: [
    AgentChatGateway,
    { provide: IAgentChatGateway, useExisting: AgentChatGateway },
    ChatWsGateway,
    AgentWsGateway,
  ],
  controllers: [AgentChatController],
  exports: [IAgentChatGateway],
})
export class AgentChatModule {}
