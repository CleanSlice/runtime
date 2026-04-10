import { ref, onMounted, onUnmounted, type Ref } from 'vue'
import { io, type Socket } from 'socket.io-client'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
  streaming?: boolean
}

export interface UseAgentChatOptions {
  /**
   * API base URL, e.g. "http://localhost:3333"
   * Will connect to socket.io namespace /ws/chat
   */
  apiUrl: string
}

export const useAgentChat = (options: UseAgentChatOptions) => {
  const messages: Ref<ChatMessage[]> = ref([])
  const isConnected = ref(false)
  const isTyping = ref(false)
  const clientId = ref<string | null>(null)

  let socket: Socket | null = null

  const connect = () => {
    socket = io(`${options.apiUrl}/ws/chat`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
    })

    socket.on('connect', () => {
      isConnected.value = true
    })

    socket.on('disconnect', () => {
      isConnected.value = false
    })

    socket.on('welcome', (data: { clientId: string }) => {
      clientId.value = data.clientId
    })

    socket.on('message', (data: { text?: string; messageId?: string; ts?: number }) => {
      isTyping.value = false
      messages.value.push({
        id: data.messageId ?? crypto.randomUUID(),
        role: 'assistant',
        text: data.text ?? '',
        ts: data.ts ?? Date.now(),
      })
    })

    socket.on('typing', () => {
      isTyping.value = true
    })

    socket.on('stream', (data: { text?: string; messageId?: string; ts?: number }) => {
      isTyping.value = false
      const idx = messages.value.findIndex(m => m.id === data.messageId)
      if (idx >= 0) {
        messages.value[idx] = { ...messages.value[idx], text: data.text ?? '', streaming: true }
      } else {
        messages.value.push({
          id: data.messageId ?? crypto.randomUUID(),
          role: 'assistant',
          text: data.text ?? '',
          ts: data.ts ?? Date.now(),
          streaming: true,
        })
      }
    })

    socket.on('stream_end', (data: { text?: string; messageId?: string; ts?: number }) => {
      isTyping.value = false
      const idx = messages.value.findIndex(m => m.id === data.messageId)
      if (idx >= 0) {
        messages.value[idx] = { ...messages.value[idx], text: data.text ?? '', streaming: false }
      } else {
        messages.value.push({
          id: data.messageId ?? crypto.randomUUID(),
          role: 'assistant',
          text: data.text ?? '',
          ts: data.ts ?? Date.now(),
        })
      }
    })
  }

  const sendMessage = (text: string, images?: Array<{ base64: string; mediaType: string }>) => {
    if (!text.trim()) return

    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      text: text.trim(),
      ts: Date.now(),
    })

    isTyping.value = true

    socket?.emit('message', {
      text: text.trim(),
      ...(images?.length ? { images } : {}),
    })
  }

  const clearMessages = () => {
    messages.value = []
  }

  onMounted(() => {
    connect()
  })

  onUnmounted(() => {
    socket?.disconnect()
  })

  return {
    messages,
    sendMessage,
    isConnected,
    isTyping,
    clearMessages,
    clientId,
  }
}
