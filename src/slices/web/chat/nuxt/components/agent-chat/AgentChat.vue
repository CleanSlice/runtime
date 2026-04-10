<script setup lang="ts">
import { ref, nextTick, watch, type HTMLAttributes } from 'vue'
import { useAgentChat } from '../../composables/useAgentChat'
import AgentChatMessage from './AgentChatMessage.vue'
import AgentChatInput from './AgentChatInput.vue'
import { Card, CardContent, CardFooter, CardHeader } from '#theme/components/ui/card'
import { ScrollArea } from '#theme/components/ui/scroll-area'
import { Bot, Circle } from 'lucide-vue-next'
import { cn } from '#theme/utils/cn'

const props = withDefaults(defineProps<{
  apiUrl: string
  title?: string
  placeholder?: string
  class?: HTMLAttributes['class']
  showStatus?: boolean
}>(), {
  title: 'Agent Chat',
  placeholder: 'Type a message...',
  showStatus: true,
})

const { messages, sendMessage, isConnected, isTyping } = useAgentChat({
  apiUrl: props.apiUrl,
})

const scrollRef = ref<InstanceType<typeof ScrollArea> | null>(null)

watch([messages, isTyping], async () => {
  await nextTick()
  const el = scrollRef.value?.$el?.querySelector('[data-radix-scroll-area-viewport]')
  if (el) el.scrollTop = el.scrollHeight
}, { deep: true })

const handleSend = (text: string) => {
  sendMessage(text)
}
</script>

<template>
  <Card :class="cn('flex flex-col h-[600px] w-full max-w-2xl', props.class)">
    <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-3 border-b">
      <div class="flex items-center gap-2">
        <Bot class="h-5 w-5" />
        <h3 class="font-semibold text-sm">{{ title }}</h3>
      </div>
      <div v-if="showStatus" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Circle
          :class="cn('h-2 w-2 fill-current', isConnected ? 'text-green-500' : 'text-red-500')"
        />
        {{ isConnected ? 'Connected' : 'Disconnected' }}
      </div>
    </CardHeader>

    <CardContent class="flex-1 overflow-hidden p-0">
      <ScrollArea ref="scrollRef" class="h-full">
        <div class="flex flex-col gap-4 p-4">
          <div
            v-if="messages.length === 0"
            class="flex-1 flex items-center justify-center text-muted-foreground text-sm py-12"
          >
            Start a conversation with the agent
          </div>

          <AgentChatMessage
            v-for="msg in messages"
            :key="msg.id"
            :message="msg"
          />

          <div v-if="isTyping" class="flex gap-3 mr-auto">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <Bot class="h-4 w-4" />
            </div>
            <div class="rounded-lg px-3 py-2 bg-muted">
              <div class="flex gap-1">
                <span class="h-2 w-2 rounded-full bg-foreground/40 animate-bounce [animation-delay:0ms]" />
                <span class="h-2 w-2 rounded-full bg-foreground/40 animate-bounce [animation-delay:150ms]" />
                <span class="h-2 w-2 rounded-full bg-foreground/40 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </CardContent>

    <CardFooter class="border-t p-3">
      <AgentChatInput
        :placeholder="placeholder"
        :disabled="!isConnected"
        @send="handleSend"
      />
    </CardFooter>
  </Card>
</template>
