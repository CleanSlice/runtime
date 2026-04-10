import { defineStore } from 'pinia'
import type { ChatMessage } from '../composables/useAgentChat'

export const useAgentChatStore = defineStore('agent-chat', {
  state: () => ({
    history: [] as ChatMessage[],
    isOpen: false,
  }),

  getters: {
    getHistory: (state) => state.history,
    getIsOpen: (state) => state.isOpen,
  },

  actions: {
    toggle() {
      this.isOpen = !this.isOpen
    },

    open() {
      this.isOpen = true
    },

    close() {
      this.isOpen = false
    },

    addMessage(message: ChatMessage) {
      this.history.push(message)
    },

    clearHistory() {
      this.history = []
    },
  },
})
