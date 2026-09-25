/**
 * Machine-readable reason attached to every {@link NavError}.
 *
 * - `INVALID_INPUT`: an array length, grid size, cell, point or option is out of range.
 * - `OUT_OF_DISK`: a world point lies outside the stop disk the plan runs over.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type NavErrorCode = 'INVALID_INPUT' | 'OUT_OF_DISK'

export class NavError extends Error {
  override name = 'NavError'
  readonly code: NavErrorCode

  constructor(code: NavErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

export function assertFiniteAtLeast(
  value: number,
  min: number,
  name: string,
  context: string,
): void {
  if (!Number.isFinite(value) || value < min) {
    throw new NavError(
      'INVALID_INPUT',
      `${context}: ${name} is ${value}; pass a finite number of at least ${min}.`,
    )
  }
}
