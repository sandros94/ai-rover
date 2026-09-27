/**
 * Machine-readable reason attached to every {@link DbError}.
 *
 * - `ALREADY_SUBMITTED`: the user already has an open submission in the round.
 * - `NOT_FOUND`: the referenced record does not exist.
 * - `INVALID_STATE`: the record exists but its state forbids the operation (a closed round, a
 *   settled submission, a stop of another mission, an identity linked elsewhere).
 * - `ROUND_CHANGED`: the round moved to another stop or anchor after the caller planned from it.
 * - `USER_GONE`: the signed-in user's account no longer exists, so nothing can be written for it.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type DbErrorCode =
  | 'ALREADY_SUBMITTED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'ROUND_CHANGED'
  | 'USER_GONE'

export class DbError extends Error {
  override name = 'DbError'
  readonly code: DbErrorCode

  constructor(code: DbErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/** Postgres unique violation on `constraint`, found anywhere along the `cause` chain. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const fields = current as Error & { code?: unknown; constraint?: unknown }
    if (fields.code === '23505' && fields.constraint === constraint) return true
  }
  return false
}

/**
 * Postgres foreign-key violation on a `user_id` column referencing `user_account`, found anywhere
 * along the `cause` chain: a write for a user whose account no longer exists.
 */
export function isMissingUserViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const fields = current as Error & { code?: unknown; constraint?: unknown }
    if (
      fields.code === '23503' &&
      typeof fields.constraint === 'string' &&
      fields.constraint.endsWith('_user_id_user_account_id_fkey')
    ) {
      return true
    }
  }
  return false
}

/** The SQLSTATE of the first Postgres error along the `cause` chain, if any. */
export function postgresErrorOf(error: unknown): { error: Error; code: string } | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as Error & { code?: unknown }
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return { error: current, code }
  }
  return undefined
}
