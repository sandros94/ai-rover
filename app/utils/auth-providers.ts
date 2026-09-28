import type { AuthProvider } from '#auth'

/** How the app names and marks each sign-in provider. */
export const PROVIDER_DISPLAY: Record<AuthProvider, { label: string; icon: string }> = {
  github: { label: 'GitHub', icon: 'i-lucide-github' },
  discord: { label: 'Discord', icon: 'i-brand-discord' },
  atproto: { label: 'AT Protocol', icon: 'i-lucide-at-sign' },
}

/** The providers signed in by a redirect alone; AT Protocol first asks for a handle. */
export const REDIRECT_PROVIDERS = ['github', 'discord'] as const satisfies AuthProvider[]

/** The URL that starts `provider`'s sign-in, landing on `redirect`. */
export function signInUrl(
  provider: AuthProvider,
  options: { redirect: string; handle?: string },
): string {
  const query = new URLSearchParams({ redirect: options.redirect })
  if (options.handle) query.set('handle', options.handle)
  return `/api/auth/${provider}?${query}`
}
