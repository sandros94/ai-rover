/**
 * Server minus browser clock, milliseconds, from one answer carrying the server's `now`: the
 * server's clock when it answered, plus the answer's `Age` header (whole seconds it spent in a
 * cache, the CDN's included), against the middle of the browser's round trip. An `Age` that is
 * not a non-negative integer counts as none.
 */
export function serverClockOffset(options: {
  serverNow: string
  age: string | null
  sentAt: number
  receivedAt: number
}): number {
  const { serverNow, age, sentAt, receivedAt } = options
  const cachedMs = age !== null && /^\d+$/.test(age) ? Number(age) * 1000 : 0
  return Date.parse(serverNow) + cachedMs - (sentAt + receivedAt) / 2
}
