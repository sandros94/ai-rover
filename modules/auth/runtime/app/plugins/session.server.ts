import { defineNuxtPlugin } from '#imports'
import { useUserSession } from '../composables/useUserSession'

export default defineNuxtPlugin({
  name: 'jev-auth:session-server',
  async setup(nuxtApp) {
    // A prerendered page is shared by everyone; the client plugin fills it per visitor.
    if (nuxtApp.payload.prerenderedAt) return
    await useUserSession().fetch()
  },
})
