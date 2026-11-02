import type { SessionData } from '#shared/types/session'

/**
 * The session as the app sees it, `{}` while signed out: filled during SSR by the
 * `session.server` plugin, kept in the payload, and re-read with `fetch()` after anything that
 * changes it server-side.
 */
export function useUserSession() {
  const session = useState<Partial<SessionData>>('rover-user-session', () => ({}))
  const request = useRequestFetch()
  // During SSR the request fetch does not carry the visitor's cookies on its own.
  const cookie = useRequestHeaders(['cookie'])
  return {
    loggedIn: computed(() => Boolean(session.value.user)),
    user: computed(() => session.value.user ?? null),
    session,
    async fetch() {
      session.value = await request<Partial<SessionData>>('/api/_auth/session', {
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
