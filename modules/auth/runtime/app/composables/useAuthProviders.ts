import { computed } from 'vue'
import { useRequestEvent, useState } from '#imports'
import type { AuthProvider } from '../../types'
import { isAuthProvider } from '../../types'

/**
 * The sign-in providers offered on the address the visitor uses: from the request during a
 * server render, else asked of `/api/auth/providers` by the browser until it answers.
 */
export async function useAuthProviders() {
  const providers = useState<AuthProvider[] | null>('rover-auth-providers', () => {
    if (!import.meta.server) return null
    // Set by the module's server middleware; the event context is untyped on this side.
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
