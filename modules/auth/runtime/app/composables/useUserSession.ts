import { computed } from 'vue'
import { useRequestFetch, useState } from '#imports'
import type { UserSession } from '../../types'

/**
 * The session as the app sees it: filled during SSR by the server plugin, kept in the payload,
 * and re-read with `fetch()` after anything that changes it server-side.
 */
export function useUserSession() {
  const session = useState<UserSession>('jev-user-session', () => ({}))
  const request = useRequestFetch()
  return {
    loggedIn: computed(() => Boolean(session.value.user)),
    user: computed(() => session.value.user ?? null),
    session,
    async fetch() {
      session.value = await request<UserSession>('/api/_auth/session', {
        headers: { accept: 'application/json' },
        retry: false,
      }).catch(() => ({}))
    },
    async clear() {
      await $fetch('/api/_auth/session', { method: 'DELETE' })
      session.value = {}
    },
  }
}
