import type { AuthProvider } from '#shared/utils/sign-in'
import { isAuthProvider } from '#shared/utils/sign-in'

/**
 * The sign-in providers offered on the address the visitor uses: from the request during a
 * server render, else asked of `/api/auth/providers` by the browser until it answers.
 */
export async function useAuthProviders() {
  const providers = useState<AuthProvider[] | null>('rover-auth-providers', () => {
    if (!import.meta.server) return null
    // Set by the server's `auth-providers` middleware; the event context is untyped on this side.
    const offered = useRequestEvent()?.context.authProviders
    return Array.isArray(offered) ? offered.filter(isAuthProvider) : []
  })
  if (providers.value === null) {
    const answer = await $fetch<{ providers: AuthProvider[] }>('/api/auth/providers').catch(
      () => null,
    )
    if (answer) providers.value = answer.providers
  }
  return computed(() => providers.value ?? [])
}
