/** A failed request to the app's own API as the interface shows it. */
export interface RequestError {
  /** The route's error code (`USER_GONE`, `MISSION_PAUSED`, …), or `error` when it gave none. */
  code: string
  /** A refused submission's reason, when the route gave one. */
  reason: string | null
  message: string
}

/** The code, refusal reason and message of what a `$fetch` to the app's API threw. */
export function requestErrorOf(caught: unknown): RequestError {
  const data = (caught as { data?: { code?: unknown; reason?: unknown; message?: unknown } }).data
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)
  return {
    code: text(data?.code) ?? 'error',
    reason: text(data?.reason),
    message: text(data?.message) ?? (caught instanceof Error ? caught.message : String(caught)),
  }
}

/**
 * Reads what a request to the app's API threw. A `USER_GONE` answer means the server cleared a
 * session whose account no longer exists, so the session state is read again and the page shows
 * the visitor as signed out.
 */
export function useRequestError() {
  const session = useUserSession()
  return async (caught: unknown): Promise<RequestError> => {
    const error = requestErrorOf(caught)
    if (error.code === 'USER_GONE') await session.fetch()
    return error
  }
}
