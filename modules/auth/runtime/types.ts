/** The identity providers a user can sign in with. */
export type AuthProvider = 'github' | 'atproto'

/**
 * The signed-in user as the session carries it. Extend it by declaration merging on `#auth`;
 * every field but `id` travels as a claim of the same name (`id` travels as `sub`), so extra
 * fields must be small, JSON-serialisable and never secret.
 */
export interface User {
  id: string
  displayName: string
  avatarUrl?: string
  handle?: string
  /** Providers proven in this browser session, in the order they were used. */
  providers: AuthProvider[]
}

export interface UserSession {
  user?: User
  /** Epoch milliseconds of the sign-in; kept across sliding refreshes and profile updates. */
  loggedInAt?: number
}

export type SignedInSession = UserSession & { user: User; loggedInAt: number }
