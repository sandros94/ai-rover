import type { AuthProvider } from '#shared/utils/sign-in'

/** How the app names and marks each sign-in provider. */
export const PROVIDER_DISPLAY: Record<AuthProvider, { label: string; icon: string }> = {
  github: { label: 'GitHub', icon: 'i-lucide-github' },
  discord: { label: 'Discord', icon: 'i-brand-discord' },
  atproto: { label: 'AT Protocol', icon: 'i-lucide-at-sign' },
}

/** The providers signed in by a redirect alone; AT Protocol first asks for a handle, in a form. */
export const REDIRECT_PROVIDERS = ['github', 'discord'] as const satisfies AuthProvider[]

/**
 * The URL that starts `provider`'s sign-in, landing on `redirect`; with `link`, the identity joins
 * the signed-in account instead. A link, and an AT Protocol start (the account named in the form's
 * `handle` field), are taken only as a `POST` from a form on this site.
 */
export function signInUrl(
  provider: AuthProvider,
  options: { redirect: string; link?: boolean },
): string {
  const query = new URLSearchParams({ redirect: options.redirect })
  if (options.link) query.set('link', '')
  return `/api/auth/${provider}?${query}`
}
