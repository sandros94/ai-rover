import { describe, expect, it } from 'vitest'
import { serverClockOffset } from '#shared/utils/client'

describe('serverClockOffset', () => {
  it('is server minus browser clock at the middle of the round trip', () => {
    expect(
      serverClockOffset({
        serverNow: '2030-01-01T00:00:10.000Z',
        age: null,
        sentAt: 0,
        receivedAt: 0,
      }),
    ).toBe(Date.parse('2030-01-01T00:00:10.000Z'))
    const sentAt = Date.parse('2030-01-01T00:00:09.000Z')
    expect(
      serverClockOffset({
        serverNow: '2030-01-01T00:00:10.000Z',
        age: null,
        sentAt,
        receivedAt: sentAt + 400,
      }),
    ).toBe(800)
  })

  it('ages an answer served from a cache by its Age header', () => {
    const sentAt = Date.parse('2030-01-01T00:00:10.000Z')
    const base = { serverNow: '2030-01-01T00:00:10.000Z', sentAt, receivedAt: sentAt }
    // Written 7 s ago and served by the CDN since: the clocks agree.
    expect(serverClockOffset({ ...base, serverNow: '2030-01-01T00:00:03.000Z', age: '7' })).toBe(0)
    expect(serverClockOffset({ ...base, age: '0' })).toBe(0)
    // Anything but a non-negative integer of seconds is ignored.
    for (const age of ['', '-3', '1.5', 'soon']) expect(serverClockOffset({ ...base, age })).toBe(0)
  })
})
