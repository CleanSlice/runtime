import { fileURLToPath } from 'url'
const currentDir = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  alias: {
    '#agent-chat': currentDir,
  },
  components: [
    { path: `${currentDir}/components`, pathPrefix: false },
  ],
})
