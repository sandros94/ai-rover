export default defineNuxtPlugin({
  name: 'session-server',
  async setup(nuxtApp) {
    // A prerendered page is shared by everyone; the client plugin fills it per visitor.
    if (nuxtApp.payload.prerenderedAt) return
    await useUserSession().fetch()
  },
})
