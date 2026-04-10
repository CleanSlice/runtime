<script setup lang="ts">
import { ref } from 'vue'
import { Textarea } from '#theme/components/ui/textarea'
import { Button } from '#theme/components/ui/button'
import { Send } from 'lucide-vue-next'

defineProps<{
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
}>()

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const handleSend = () => {
  if (!input.value.trim()) return
  emit('send', input.value)
  input.value = ''
  textareaRef.value?.focus()
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="flex w-full gap-2">
    <Textarea
      ref="textareaRef"
      v-model="input"
      :placeholder="placeholder"
      :disabled="disabled"
      class="min-h-[40px] max-h-[120px] resize-none"
      :rows="1"
      @keydown="handleKeydown"
    />
    <Button
      size="icon"
      :disabled="!input.trim() || disabled"
      class="shrink-0"
      @click="handleSend"
    >
      <Send class="h-4 w-4" />
    </Button>
  </div>
</template>
