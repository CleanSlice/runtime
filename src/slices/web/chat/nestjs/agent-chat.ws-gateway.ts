import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets'
import { Logger } from '@nestjs/common'
import { Server, Socket } from 'socket.io'
import { randomUUID } from 'crypto'
import { IAgentChatGateway } from './domain'

/**
 * WebSocket gateway for BROWSER clients.
 * Browsers connect here: ws://api-host/ws/chat
 *
 * Events (browser → API):
 *   "message"  { text, images? }
 *   "ping"     {}
 *
 * Events (API → browser):
 *   "connected"   { clientId }
 *   "message"     { text, messageId, ts }
 *   "stream"      { text, messageId, ts }
 *   "stream_end"  { text, messageId, ts }
 *   "typing"      { ts }
 *   "pong"        { ts }
 */
@WebSocketGateway({ namespace: '/ws/chat', cors: { origin: '*' } })
export class ChatWsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(ChatWsGateway.name)

  constructor(private readonly hub: IAgentChatGateway) {}

  handleConnection(client: Socket) {
    const clientId = randomUUID()
    client.data = { clientId }

    const send = (data: unknown) => {
      const event = (data as any)?.type ?? 'data'
      client.emit(event, data)
    }

    this.hub.registerClient(clientId, send)
    client.emit('welcome', { clientId })

    this.logger.log(`Browser client connected: ${clientId}`)
  }

  handleDisconnect(client: Socket) {
    const clientId = client.data?.clientId
    if (clientId) {
      this.hub.unregisterClient(clientId)
      this.logger.log(`Browser client disconnected: ${clientId}`)
    }
  }

  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { text?: string; images?: Array<{ base64: string; mediaType: string }> },
  ) {
    const clientId = client.data?.clientId
    if (!clientId || !data?.text) return

    this.hub.sendToAgent(clientId, data.text, data.images)
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { ts: Date.now() })
  }
}
