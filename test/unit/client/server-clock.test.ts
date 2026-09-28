import { describe, expect, it } from 'vitest'
import {
  CLOCK_OFFSET_WINDOW,
  ClientError,
  createClockOffsetEstimate,
  serverClockOffset,
} from '#shared/utils/client'

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

describe('createClockOffsetEstimate', () => {
  it('has no estimate before the first sample, then takes it', () => {
    const estimate = createClockOffsetEstimate()
    expect(estimate.offsetMs).toBeNull()
    expect(estimate.add(420)).toBe(420)
    expect(estimate.offsetMs).toBe(420)
  })

  it('ignores a single outlier among the samples it keeps', () => {
    const estimate = createClockOffsetEstimate()
    for (const sample of [1000, 1040, 980, 1020]) estimate.add(sample)
    const before = estimate.add(1010)
    expect(before).toBe(1010)
    // A stale CDN copy, a second off, barely moves it.
    expect(estimate.add(2000)).toBe(1015)
    expect(estimate.add(-500)).toBe(1010)
  })

  it('forgets samples older than the window', () => {
    const estimate = createClockOffsetEstimate()
    for (let i = 0; i < CLOCK_OFFSET_WINDOW; i++) estimate.add(0)
    for (let i = 0; i < CLOCK_OFFSET_WINDOW / 2; i++) estimate.add(3000)
    expect(estimate.offsetMs).toBe(1500)
    estimate.add(3000)
    expect(estimate.offsetMs).toBe(3000)
  })

  it('refuses a sample that is not finite', () => {
    expect(() => createClockOffsetEstimate().add(Number.NaN)).toThrow(ClientError)
  })
})
