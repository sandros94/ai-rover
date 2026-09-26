import { describe, expect, it } from 'vitest'
import {
  ClientError,
  createPlaylist,
  createPlaylistClock,
  PLAYLIST_PREFETCH_AT,
} from '#shared/utils/client'

/** Three segments of 100, 50 and 200 sim seconds: boundaries at 100 and 150, 350 in all. */
const SEGMENTS = [
  { id: 'a', durationS: 100 },
  { id: 'b', durationS: 50 },
  { id: 'c', durationS: 200 },
]

describe('createPlaylist', () => {
  it('lays the segments back to back', () => {
    const playlist = createPlaylist(SEGMENTS)
    expect(playlist.duration).toBe(350)
    expect(playlist.starts).toEqual([0, 100, 150])
    expect(playlist.segments).toBe(SEGMENTS)
  })

  it('maps playlist time to a segment and its sim time, a boundary opening the next', () => {
    const playlist = createPlaylist(SEGMENTS)
    expect(playlist.locate(0)).toEqual({ segmentIndex: 0, simTime: 0 })
    expect(playlist.locate(99.5)).toEqual({ segmentIndex: 0, simTime: 99.5 })
    expect(playlist.locate(100)).toEqual({ segmentIndex: 1, simTime: 0 })
    expect(playlist.locate(149.9)).toEqual({ segmentIndex: 1, simTime: expect.closeTo(49.9) })
    expect(playlist.locate(150)).toEqual({ segmentIndex: 2, simTime: 0 })
    // The end belongs to the last segment, at its own end.
    expect(playlist.locate(350)).toEqual({ segmentIndex: 2, simTime: 200 })
  })

  it('clamps times outside the playlist to its ends', () => {
    const playlist = createPlaylist(SEGMENTS)
    expect(playlist.locate(-5)).toEqual({ segmentIndex: 0, simTime: 0 })
    expect(playlist.locate(1e9)).toEqual({ segmentIndex: 2, simTime: 200 })
  })

  it('maps a segment and its sim time back to playlist time, round-tripping', () => {
    const playlist = createPlaylist(SEGMENTS)
    expect(playlist.timeOf(0, 0)).toBe(0)
    expect(playlist.timeOf(1, 0)).toBe(100)
    expect(playlist.timeOf(1, 50)).toBe(150)
    expect(playlist.timeOf(2, 20)).toBe(170)
    // Sim time past the segment's end is clamped to it.
    expect(playlist.timeOf(1, 80)).toBe(150)
    for (const t of [0, 42, 100, 120, 150, 349, 350]) {
      const { segmentIndex, simTime } = playlist.locate(t)
      expect(playlist.timeOf(segmentIndex, simTime)).toBeCloseTo(t)
    }
  })

  it('skips a segment of no duration', () => {
    const playlist = createPlaylist([{ durationS: 10 }, { durationS: 0 }, { durationS: 10 }])
    expect(playlist.starts).toEqual([0, 10, 10])
    expect(playlist.locate(10)).toEqual({ segmentIndex: 2, simTime: 0 })
  })

  it('reads how far contiguous held data reaches from a segment', () => {
    const playlist = createPlaylist(SEGMENTS)
    // Nothing held: playback holds at the segment's start.
    expect(playlist.heldUntil(0, () => 0)).toBe(0)
    expect(playlist.heldUntil(1, () => 0)).toBe(100)
    // Part of the current segment.
    expect(playlist.heldUntil(0, (k) => (k === 0 ? 60 : 0))).toBe(60)
    // The current segment whole runs on into what the next one holds.
    expect(playlist.heldUntil(0, (k) => (k === 0 ? 100 : k === 1 ? 20 : 0))).toBe(120)
    expect(playlist.heldUntil(0, (k) => SEGMENTS[k]!.durationS)).toBe(350)
    // Holding more than a segment lasts counts as the whole of it.
    expect(playlist.heldUntil(1, () => Infinity)).toBe(350)
  })

  it(`names the next segment to prefetch once the current one is ${PLAYLIST_PREFETCH_AT * 100} % through`, () => {
    const playlist = createPlaylist(SEGMENTS)
    expect(PLAYLIST_PREFETCH_AT).toBe(0.8)
    expect(playlist.prefetchIndex(0)).toBeUndefined()
    expect(playlist.prefetchIndex(79.9)).toBeUndefined()
    expect(playlist.prefetchIndex(80)).toBe(1)
    expect(playlist.prefetchIndex(99.9)).toBe(1)
    expect(playlist.prefetchIndex(100)).toBeUndefined()
    expect(playlist.prefetchIndex(140)).toBe(2)
    // The last segment has nothing after it.
    expect(playlist.prefetchIndex(340)).toBeUndefined()
  })

  it('refuses an empty list, bad durations and out-of-range lookups with typed errors', () => {
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (caught) {
        return caught instanceof ClientError ? caught.code : 'other'
      }
      return 'none'
    }
    expect(code(() => createPlaylist([]))).toBe('INVALID_INPUT')
    expect(code(() => createPlaylist([{ durationS: -1 }]))).toBe('INVALID_INPUT')
    expect(code(() => createPlaylist([{ durationS: Number.NaN }]))).toBe('INVALID_INPUT')
    const playlist = createPlaylist(SEGMENTS)
    expect(code(() => playlist.locate(Number.NaN))).toBe('INVALID_INPUT')
    expect(code(() => playlist.timeOf(3, 0))).toBe('INVALID_INPUT')
    expect(code(() => playlist.timeOf(-1, 0))).toBe('INVALID_INPUT')
  })
})

describe('createPlaylistClock', () => {
  function setup(duration = 350) {
    let wall = 1_000_000
    const clock = createPlaylistClock({ now: () => wall, duration })
    return {
      clock,
      at: (ms: number) => {
        wall = ms
        return ms
      },
    }
  }

  it('plays from 0 at the chosen rate and stops at the end', () => {
    const { clock, at } = setup()
    expect(clock.tick(at(1_000_000))).toBe(0)
    clock.setRate(10)
    expect(clock.tick(at(1_010_000))).toBe(100)
    expect(clock.ended).toBe(false)
    expect(clock.tick(at(1_100_000))).toBe(350)
    expect(clock.ended).toBe(true)
  })

  it('holds at the held edge and goes on from there, never jumping', () => {
    const { clock, at } = setup()
    clock.setRate(10)
    expect(clock.tick(at(1_010_000), 60)).toBe(60)
    expect(clock.tick(at(1_020_000), 60)).toBe(60)
    // More arrives: playback continues from the hold rather than where it would have been.
    expect(clock.tick(at(1_021_000), Infinity)).toBe(70)
  })

  it('never moves back to a held edge behind a seek', () => {
    const { clock, at } = setup()
    clock.seek(200)
    expect(clock.tick(at(1_005_000), 100)).toBe(200)
  })

  it('pauses, seeks within the playlist and restarts from the end on play', () => {
    const { clock, at } = setup()
    clock.setRate(60)
    clock.tick(at(1_001_000))
    clock.pause()
    expect(clock.paused).toBe(true)
    expect(clock.tick(at(1_005_000))).toBe(60)
    clock.seek(-10)
    expect(clock.tick(at(1_006_000))).toBe(0)
    clock.seek(1e6)
    expect(clock.tick(at(1_007_000))).toBe(350)
    clock.play()
    expect(clock.paused).toBe(false)
    expect(clock.tick(at(1_007_000))).toBe(0)
  })

  it('refuses a bad duration, seek or rate', () => {
    expect(() => createPlaylistClock({ now: () => 0, duration: -1 })).toThrow(ClientError)
    const { clock } = setup()
    expect(() => clock.seek(Number.NaN)).toThrow(ClientError)
    // @ts-expect-error -- not an offered rate
    expect(() => clock.setRate(3)).toThrow(ClientError)
  })
})
