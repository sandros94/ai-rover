/**
 * Machine-readable reason attached to every {@link RoverError}.
 *
 * - `INVALID_GEOMETRY`: a rover geometry field is non-finite, out of range or out of layout order.
 * - `INVALID_LIMITS`: a limit passed to `checkLimits` is not a finite, non-negative number.
 * - `INVALID_POSE`: a planar or solved pose field is non-finite, or the height function returns a
 *   non-finite height under the rover.
 * - `NO_CONTACT`: no suspension state puts all six wheels on the ground at the pose.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type RoverErrorCode = 'INVALID_GEOMETRY' | 'INVALID_LIMITS' | 'INVALID_POSE' | 'NO_CONTACT'

export class RoverError extends Error {
  override name = 'RoverError'
  readonly code: RoverErrorCode

  constructor(code: RoverErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
