/**
 * Machine-readable reason attached to every {@link LifecycleError}.
 *
 * - `NO_ACTIVE_MISSION`: no mission is active, so there is nothing to act on.
 * - `MISSION_ACTIVE`: a mission is active, and another lands only once none is.
 * - `NO_OPEN_ROUND`: the mission has no open round to submit to (it has ended).
 * - `MISSION_PAUSED`: an operator paused the mission; the message is theirs. Submissions and
 *   likes wait until it resumes.
 * - `NOT_PUBLISHED`: a stop's journey blobs are missing from the store the lifecycle was given.
 * - `WORLD_MISMATCH`: the world rebuilt from a mission's stored seed and config hashes differently
 *   from the one it was created with.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type LifecycleErrorCode =
  | 'NO_ACTIVE_MISSION'
  | 'MISSION_ACTIVE'
  | 'NO_OPEN_ROUND'
  | 'MISSION_PAUSED'
  | 'NOT_PUBLISHED'
  | 'WORLD_MISMATCH'

export class LifecycleError extends Error {
  override name = 'LifecycleError'
  readonly code: LifecycleErrorCode

  constructor(code: LifecycleErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
