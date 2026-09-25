/**
 * Machine-readable reason attached to every {@link DbError}.
 *
 * - `ALREADY_SUBMITTED`: the user already has an open submission in the round.
 * - `NOT_FOUND`: the referenced record does not exist.
 * - `INVALID_STATE`: the record exists but its state forbids the operation (a closed round, a
 *   settled submission, a stop of another mission, an identity linked elsewhere).
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type DbErrorCode = 'ALREADY_SUBMITTED' | 'NOT_FOUND' | 'INVALID_STATE'

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
