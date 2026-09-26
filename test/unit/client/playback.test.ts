import { describe, expect, it } from 'vitest'
import { sliceGate } from '#shared/utils/drive'
import type { PlaybackRate } from '#shared/utils/client'
import {
  ClientError,
  createPlaybackClock,
  DEFAULT_LIVE_MARGIN_SECONDS,
  PLAYBACK_RATES,
} from '#shared/utils/client'

const startedAt = Date.UTC(2026, 8, 26, 12)
const sliceSeconds = 30

function setup(options: { liveLagSeconds?: number } = {}) {
  let wall = startedAt
  const clock = createPlaybackClock({ now: () => wall, startedAt, sliceSeconds, ...options })
  return {
    clock,
    at: (ms: number) => {
      wall = ms
      return ms
    },
  }
}

describe('createPlaybackClock', () => {
  it('counts released slices exactly as sliceGate releases them', () => {
    const { clock } = setup()
    const manifest = { startedAt, sliceSeconds }
    for (let wall = startedAt - 5000; wall < startedAt + 200_000; wall += 250) {
      let released = 0
      while (sliceGate(manifest, released, wall).released) released++
      expect(clock.releasedSliceCount(wall), `${wall - startedAt} ms`).toBe(released)
    }
    for (let k = 0; k < 400; k++) {
      const end = startedAt + (k + 1) * sliceSeconds * 1000
      expect(clock.releasedSliceCount(end - 1)).toBe(k)
      expect(clock.releasedSliceCount(end)).toBe(k + 1)
      expect(clock.releaseAt(k)).toBe(end)
    }
  })

  it('plays live one lag behind wall-clock, never past the released slices', () => {
    const { clock } = setup()
    const lag = sliceSeconds + DEFAULT_LIVE_MARGIN_SECONDS
    expect(clock.mode).toBe('live')
    expect(clock.rate).toBe(1)
    expect(clock.simTimeAt(startedAt - 60_000)).toBe(0)
    expect(clock.simTimeAt(startedAt + lag * 1000)).toBe(0)
    expect(clock.simTimeAt(startedAt + (lag + 12.5) * 1000)).toBe(12.5)
    expect(clock.simTimeAt(startedAt + (lag + 13.5) * 1000)).toBe(13.5)
    for (let wall = startedAt; wall < startedAt + 600_000; wall += 125) {
      expect(clock.simTimeAt(wall)).toBeLessThanOrEqual(
        clock.releasedSliceCount(wall) * sliceSeconds,
      )
    }
  })

  it('at the minimum lag of one slice, meets each slice end exactly as the next slice releases', () => {
    const { clock } = setup({ liveLagSeconds: sliceSeconds })
    for (let k = 1; k < 10; k++) {
      const release = clock.releaseAt(k)
      expect(clock.simTimeAt(release)).toBe(k * sliceSeconds)
      expect(clock.simTimeAt(release - 1)).toBeLessThan(k * sliceSeconds)
      expect(clock.releasedSliceCount(release) * sliceSeconds).toBe((k + 1) * sliceSeconds)
    }
  })

  it('replays from a seek at the chosen rate, and rejoins live at the edge', () => {
    const { clock, at } = setup()
    const w = at(startedAt + 3_600_000)
    const live = clock.simTimeAt(w)
    clock.seek(100)
    expect(clock.mode).toBe('replay')
    expect(clock.simTimeAt(w)).toBe(100)
    expect(clock.simTimeAt(w + 2000)).toBe(102)
    at(w + 2000)
    clock.setRate(60)
    expect(clock.rate).toBe(60)
    expect(clock.simTimeAt(w + 3000)).toBe(162)
    expect(clock.tick(w + 3000)).toBe(162)
    expect(clock.simTime).toBe(162)
    expect(clock.mode).toBe('replay')
    // At 60× the replay catches the live edge, which moves at 1×, after (live − 102) / 59 s.
    const catchUp = w + 2000 + ((live - 102) / 59) * 1000
    expect(clock.tick(catchUp - 1000)).toBeLessThan(clock.liveTimeAt(catchUp - 1000))
    expect(clock.mode).toBe('replay')
    const after = catchUp + 10_000
    expect(clock.tick(after)).toBeCloseTo((after - startedAt) / 1000 - 35, 9)
    expect(clock.mode).toBe('live')
  })

  it('pauses on the shown sim time and plays on from it', () => {
    const { clock, at } = setup()
    // Live at 100 s of wall-clock: 65 s of sim time with the 35 s lag.
    at(startedAt + 100_000)
    expect(clock.tick(startedAt + 100_000)).toBe(65)
    clock.pause()
    expect(clock.paused).toBe(true)
    expect(clock.mode).toBe('replay')
    // Paused, wall-clock passes and the sim time holds, even with the live edge far ahead.
    expect(clock.tick(startedAt + 400_000)).toBe(65)
    expect(clock.mode).toBe('replay')
    clock.setRate(10)
    clock.seek(20)
    expect(clock.paused).toBe(true)
    expect(clock.tick(at(startedAt + 500_000))).toBe(20)
    clock.play()
    expect(clock.paused).toBe(false)
    expect(clock.tick(startedAt + 502_000)).toBe(40)
  })

  it('pauses at the start of a drive without rejoining live, and live ends the pause', () => {
    const { clock, at } = setup()
    at(startedAt)
    clock.pause()
    expect(clock.tick(startedAt)).toBe(0)
    expect(clock.mode).toBe('replay')
    clock.goLive()
    expect(clock.paused).toBe(false)
    expect(clock.mode).toBe('live')
    expect(clock.tick(startedAt + 100_000)).toBe(65)
  })

  it('clamps a seek to the start and to the live edge', () => {
    const { clock, at } = setup()
    const w = at(startedAt + 100_000)
    clock.seek(-20)
    expect(clock.simTimeAt(w)).toBe(0)
    clock.seek(10_000)
    expect(clock.simTimeAt(w)).toBe(65)
    clock.goLive()
    expect(clock.mode).toBe('live')
  })

  it('offers the replay rates 1, 10, 60 and 200 only', () => {
    expect(PLAYBACK_RATES).toEqual([1, 10, 60, 200])
    const { clock } = setup()
    for (const rate of PLAYBACK_RATES) {
      clock.setRate(rate)
      expect(clock.rate).toBe(rate)
    }
    const error = (() => {
      try {
        clock.setRate(7 as PlaybackRate)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(ClientError)
    expect((error as ClientError).code).toBe('INVALID_INPUT')
  })

  it('refuses a lag under one slice, a bad start or slice length, and a non-finite seek', () => {
    expect(() => setup({ liveLagSeconds: sliceSeconds - 1 })).toThrow(ClientError)
    expect(() =>
      createPlaybackClock({ now: () => 0, startedAt: Number.NaN, sliceSeconds }),
    ).toThrow(ClientError)
    expect(() => createPlaybackClock({ now: () => 0, startedAt, sliceSeconds: 0 })).toThrow(
      ClientError,
    )
    expect(() => setup().clock.seek(Number.NaN)).toThrow(ClientError)
  })
})
