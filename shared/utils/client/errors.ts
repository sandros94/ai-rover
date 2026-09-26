/**
 * Machine-readable reason attached to every {@link ClientError}.
 *
 * - `NETWORK`: the request failed, or the server answered neither the blob nor a 404.
 * - `DECODE`: the response is not the format its key names, or names other coordinates.
 * - `NOT_FOUND`: the server answered 404 for a blob that must exist.
 * - `INVALID_INPUT`: an option, time or rate passed by the caller is out of range.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type ClientErrorCode = 'NETWORK' | 'DECODE' | 'NOT_FOUND' | 'INVALID_INPUT'

export class ClientError extends Error {
  override name = 'ClientError'
  readonly code: ClientErrorCode

  constructor(code: ClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
