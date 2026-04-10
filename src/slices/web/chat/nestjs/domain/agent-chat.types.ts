export interface IAgentImageData {
  base64: string
  mediaType: string
}

/** API → Agent: incoming message from a browser client */
export interface IAgentIncomingMessage {
  type: 'message'
  clientId: string
  text: string
  messageId: string
  images?: IAgentImageData[]
}

/** Agent → API: events routed to browser clients */
export interface IAgentOutgoingEvent {
  type: 'register' | 'message' | 'stream' | 'stream_end' | 'typing' | 'ping'
  clientId?: string
  text?: string
  messageId?: string
  ts?: number
}

/** Health check response */
export interface IAgentHealthData {
  ok: boolean
  agentConnected: boolean
  browserClients: number
}
