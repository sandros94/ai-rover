/**
 * Machine-readable reason attached to every {@link DriveError}.
 *
 * - `INVALID_INPUT`: a drive option, point, pose or time is out of range.
 * - `INVALID_RECORD`: a keyframe block or buffer is not that format, or its sizes disagree.
 * - `UNSUPPORTED_VERSION`: a binary format version or flags are unknown to its decoder.
 * - `TRUNCATED`: a binary buffer ends before its declared content.
 * - `TRAILING_DATA`: a binary buffer continues past its declared content.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type DriveErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_RECORD'
  | 'UNSUPPORTED_VERSION'
  | 'TRUNCATED'
  | 'TRAILING_DATA'

export class DriveError extends Error {
  override name = 'DriveError'
  readonly code: DriveErrorCode

  constructor(code: DriveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
