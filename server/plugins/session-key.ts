import { definePlugin } from 'nitro'
import { deriveSecret } from 'nuxt/server'

// Derives a secret at startup, so a server without a usable NUXT_APP_SECRET fails every request
// from the start instead of its first signed-in one.
export default definePlugin(async () => {
  await deriveSecret('ai-rover:session')
})
