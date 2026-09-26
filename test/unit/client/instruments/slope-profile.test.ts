import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import { slopeProfile } from '#shared/utils/client/instruments/slope-profile'

const SIZE = 41
/** A plane rising 0.1 m per metre east, 1 m cells, world vertex (−20, −20) at grid (0, 0). */
function ground(revealed: (i: number, j: number) => boolean) {
  const heights = new Float32Array(SIZE * SIZE)
  const seen = new Uint8Array(SIZE * SIZE)
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      heights[j * SIZE + i] = 0.1 * i
      seen[j * SIZE + i] = revealed(i, j) ? 1 : 0
    }
  }
  const grid: HeightGrid = { heights, width: SIZE, height: SIZE, cellSize: 1 }
  return { grid, origin: { i: -20, j: -20 }, revealed: seen }
}

const SLOPE = Math.atan(0.1) * (180 / Math.PI)

describe('slopeProfile', () => {
  it('samples every step along the polyline and ends at its length', () => {
    const line = [
      { x: -10, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 7.5 },
    ]
    const profile = slopeProfile(
      line,
      ground(() => true),
      { stepM: 2 },
    )
    expect(profile.lengthM).toBeCloseTo(17.5, 12)
    expect(profile.samples).toHaveLength(Math.ceil(17.5 / 2) + 1)
    expect(profile.samples[0]!.distanceM).toBe(0)
    expect(profile.samples.at(-1)!.distanceM).toBeCloseTo(17.5, 12)
    for (const s of profile.samples) expect(s.slopeDeg).toBeCloseTo(SLOPE, 4)
  })

  it('leaves the slope of unseen ground out', () => {
    const profile = slopeProfile(
      [
        { x: -10, y: 0 },
        { x: 10, y: 0 },
      ],
      ground((i) => i < 20),
      { stepM: 5 },
    )
    expect(profile.samples.map((s) => s.slopeDeg === null)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ])
  })

  it('returns one sample for a single-point route', () => {
    const profile = slopeProfile(
      [{ x: 0, y: 0 }],
      ground(() => true),
    )
    expect(profile.lengthM).toBe(0)
    expect(profile.samples).toHaveLength(1)
  })

  it('treats ground outside the grid as unseen', () => {
    const profile = slopeProfile(
      [
        { x: 15, y: 0 },
        { x: 30, y: 0 },
      ],
      ground(() => true),
      { stepM: 15 },
    )
    expect(profile.samples.map((s) => s.slopeDeg === null)).toEqual([false, true])
  })
})
