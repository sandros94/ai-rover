import type { AuthProvider } from '#shared/utils/sign-in'

/**
 * The signed-in user as the session cookie carries it: small, JSON-serialisable and never
 * secret, since the whole of it travels in every request.
 */
export interface SessionUser {
  id: string
  displayName: string
  avatarUrl?: string
  handle?: string
  /** Providers proven in this browser session, in the order they were used. */
  providers: AuthProvider[]
}

/** What the session holds while someone is signed in; `GET /api/_auth/session` answers it. */
export interface SessionData {
  user: SessionUser
  /**
   * Epoch milliseconds of the sign-in: kept across rolling re-issues, profile updates and a new
   * sign-in by the same user, reset when another user signs in.
   */
  loggedInAt: number
}
