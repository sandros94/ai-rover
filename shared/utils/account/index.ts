import type { AuthProvider } from '#auth'

/** The signed-in user's own account as the settings page reads it. */
export interface AccountView {
  id: string
  /** Null only for an account no identity signs into. */
  primaryProvider: AuthProvider | null
  identities: {
    provider: AuthProvider
    /** The provider's stable account id: with `provider`, the identity's key. */
    subject: string
    displayName: string
    avatarUrl: string | null
    handle: string | null
    linkedAt: string | Date
  }[]
}
