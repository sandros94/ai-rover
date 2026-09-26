import { computed } from 'vue'
import { useRequestFetch, useRequestHeaders, useState } from '#imports'
import type { UserSession } from '../../types'

/**
 * The session as the app sees it: filled during SSR by the server plugin, kept in the payload,
 * and re-read with `fetch()` after anything that changes it server-side.
 */
export function useUserSession() {
  const session = useState<UserSession>('jev-user-session', () => ({}))
  const request = useRequestFetch()
  // During SSR the request fetch does not carry the visitor's cookies on its own.
  const cookie = useRequestHeaders(['cookie'])
  return {
    loggedIn: computed(() => Boolean(session.value.user)),
    user: computed(() => session.value.user ?? null),
    session,
    async fetch() {
      session.value = await request<UserSession>('/api/_auth/session', {
        headers: { accept: 'application/json', ...cookie },
        retry: false,
      }).catch(() => ({}))
    },
    async clear() {
      await $fetch('/api/_auth/session', { method: 'DELETE' })
      session.value = {}
    },
  }
}
