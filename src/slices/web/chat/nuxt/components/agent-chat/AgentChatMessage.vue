<script setup lang="ts">
import type { ChatMessage } from '../../composables/useAgentChat'
import { Bot, User } from 'lucide-vue-next'
import { cn } from '#theme/utils/cn'

defineProps<{
  message: ChatMessage
}>()
</script>

<template>
  <div
    :class="cn(
      'flex gap-3 max-w-[85%]',
      message.role === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto',
    )"
  >
    <div
      :class="cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs',
        message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted',
      )"
    >
      <User v-if="message.role === 'user'" class="h-4 w-4" />
      <Bot v-else class="h-4 w-4" />
    </div>

    <div
      :class="cn(
        'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
        message.role === 'user'
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted',
        message.streaming && 'border-l-2 border-primary',
      )"
    >
      {{ message.text }}
    </div>
  </div>
</template>
