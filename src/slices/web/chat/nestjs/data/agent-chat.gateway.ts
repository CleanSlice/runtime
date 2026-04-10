import { Injectable, Logger } from '@nestjs/common'
import { IAgentChatGateway } from '../domain/agent-chat.gateway'
import type { IAgentHealthData, IAgentImageData } from '../domain/agent-chat.types'
import { randomUUID } from 'crypto'

/**
 * Hub implementation — holds references to the agent WS connection
 * and all browser client WS connections, routes messages between them.
 */
@Injectable()
export class AgentChatGateway extends IAgentChatGateway {
  private readonly logger = new Logger(AgentChatGateway.name)

  /** Browser clients: clientId → send function */
  private clients = new Map<string, (data: unknown) => void>()

  /** Agent send function (null if agent not connected) */
  private agentSend: ((data: unknown) => void) | null = null

  registerClient(clientId: string, send: (data: unknown) => void): void {
    this.clients.set(clientId, send)
    this.logger.log(`Browser client registered: ${clientId} (total: ${this.clients.size})`)
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId)
    this.logger.log(`Browser client unregistered: ${clientId} (total: ${this.clients.size})`)
  }

  registerAgent(send: (data: unknown) => void): void {
    this.agentSend = send
    this.logger.log('Agent connected')
  }

  unregisterAgent(): void {
    this.agentSend = null
    this.logger.warn('Agent disconnected')
  }

  sendToAgent(clientId: string, text: string, images?: IAgentImageData[]): void {
    if (!this.agentSend) {
      this.logger.warn('Cannot send to agent — not connected')
      // Notify client that agent is unavailable
      this.sendToClient(clientId, {
        type: 'message',
        text: 'Agent is not connected. Please try again later.',
        messageId: randomUUID(),
        ts: Date.now(),
      })
      return
    }

    this.agentSend({
      type: 'message',
      clientId,
      text,
      messageId: randomUUID(),
      ...(images?.length ? { images } : {}),
    })
  }

  sendToClient(clientId: string, data: unknown): void {
    const send = this.clients.get(clientId)
    if (send) {
      send(data)
    }
  }

  /** Called when agent sends an event — route it to the target browser client */
  handleAgentEvent(data: any): void {
    const clientId = data.clientId
    if (!clientId) return

    const send = this.clients.get(clientId)
    if (send) {
      send(data)
    }
  }

  health(): IAgentHealthData {
    return {
      ok: true,
      agentConnected: this.agentSend !== null,
      browserClients: this.clients.size,
    }
  }
}
