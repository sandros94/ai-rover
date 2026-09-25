/**
 * Machine-readable reason attached to every {@link TerrainError}.
 *
 * - `INVALID_CONFIG`: a world configuration field is out of range.
 * - `INVALID_GRID`: grid dimensions, cell size or array lengths do not agree.
 * - `OUT_OF_BOUNDS`: a cell or chunk coordinate lies outside what the call accepts.
 * - `INVALID_MAGIC`: bytes handed to a binary decoder (chunk, revealed mask) are not that format.
 * - `UNSUPPORTED_VERSION`: a binary format version or flags are unknown to its decoder.
 * - `TRUNCATED`: a binary buffer ends before its declared content.
 * - `TRAILING_DATA`: a binary buffer continues past its declared content.
 * - `INVALID_MANIFEST`: a stop manifest does not match its schema; `cause` is the `ValiError`.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type TerrainErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_GRID'
  | 'OUT_OF_BOUNDS'
  | 'INVALID_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'TRUNCATED'
  | 'TRAILING_DATA'
  | 'INVALID_MANIFEST'

export class TerrainError extends Error {
  override name = 'TerrainError'
  readonly code: TerrainErrorCode

  constructor(code: TerrainErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
