import { defineNuxtPlugin } from '#imports'
import { useUserSession } from '../composables/useUserSession'

export default defineNuxtPlugin({
  name: 'jev-auth:session-client',
  setup(nuxtApp) {
    const session = useUserSession()
    // Server-rendered pages arrive with the session in the payload; the rest read it once mounted.
    if (!nuxtApp.payload.serverRendered || nuxtApp.payload.prerenderedAt) {
      nuxtApp.hook('app:mounted', () => session.fetch())
    }
  },
})
