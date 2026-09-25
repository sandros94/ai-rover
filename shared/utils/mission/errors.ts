/**
 * Machine-readable reason attached to every {@link MissionError}.
 *
 * - `INVALID_INPUT`: an argument is out of range or empty where a value is required.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type MissionErrorCode = 'INVALID_INPUT'

export class MissionError extends Error {
  override name = 'MissionError'
  readonly code: MissionErrorCode

  constructor(code: MissionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
