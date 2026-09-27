/**
 * What `/login?error=<code>` tells the user, by the code the sign-in routes redirect with. The
 * codes never carry the failure's message: that stays in the server log.
 */
export const SIGN_IN_ERRORS = {
  'state-mismatch': 'The sign-in expired or was started in another window. Try again.',
  'refused': 'The sign-in was not authorized.',
  'handle': 'That handle does not lead to an account. Check it and try again.',
  'link-changed': 'You were signed in as someone else while linking. Sign in and link again.',
  'account-taken': 'That account already belongs to another user. Sign in with it instead.',
  'provider': 'The sign-in provider did not answer as expected. Try again in a moment.',
  'database': 'AI Rover could not reach its database. Try again in a moment.',
  'sign-in-failed': 'Something went wrong while signing you in. Try again.',
} as const

export type SignInErrorCode = keyof typeof SIGN_IN_ERRORS

/** Said for a code this build does not know, such as one from an older or newer server. */
export const UNKNOWN_SIGN_IN_ERROR = 'The sign-in did not complete. Try again.'

export function signInErrorSentence(code: string): string {
  return Object.hasOwn(SIGN_IN_ERRORS, code)
    ? SIGN_IN_ERRORS[code as SignInErrorCode]
    : UNKNOWN_SIGN_IN_ERROR
}
