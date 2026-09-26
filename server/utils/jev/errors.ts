/**
 * Machine-readable reason attached to every {@link JudgeError}.
 *
 * - `NOT_CONFIGURED`: no TypeSafe API key (`NUXT_TYPESAFE_TOKEN`) is set.
 * - `UPSTREAM`: the API failed, timed out or answered outside the questions asked. The message is
 *   always {@link JUDGE_UNAVAILABLE}, safe to show; `cause` holds what went wrong, for the logs.
 * - `INVALID_SUMMARY`: the state is not a valid `SubmissionSummary` or is too large to judge well.
 *
 * Closed set: callers may match on it exhaustively, so adding a code is a breaking change.
 */
export type JudgeErrorCode = 'NOT_CONFIGURED' | 'UPSTREAM' | 'INVALID_SUMMARY'

/** The public message of every `UPSTREAM` {@link JudgeError}. */
export const JUDGE_UNAVAILABLE = 'The judgment service is unavailable; try again shortly.'

export class JudgeError extends Error {
  override name = 'JudgeError'
  readonly code: JudgeErrorCode

  constructor(code: JudgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
